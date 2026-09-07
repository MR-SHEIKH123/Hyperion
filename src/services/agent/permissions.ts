/**
 * The permission engine.
 *
 * One question, asked in one place: *may this tool call run?* Before 1.27 the
 * answer came from `AgentMode` — three hardcoded branches inside
 * `dispatchToolCall`, with Ask refusing everything and Plan refusing anything the
 * agent's own `ToolPolicy` classified as mutating. That gate worked and could not
 * express anything: "read anywhere, write only under `src/`, ask before `bash`"
 * had nowhere to live.
 *
 * So the decision moves here and the three modes become profiles that configure
 * it. `dispatchToolCall` still calls exactly one function, at exactly the same
 * point in the loop, for exactly the same reason (see `loop.ts`'s header): a gate
 * that can be reached from more than one place is a gate somebody will forget.
 *
 * ## Layers
 *
 * Four layers, each able to omit a key and fall through to the one before it:
 *
 *     builtin  →  profile  →  project  →  session
 *
 * `builtin` is the profile's own baseline (what Ask/Plan/Act mean). `profile` is
 * a project-authored `.hyperion/agents/*.md` front-matter block. `project` is
 * `.hyperion/permissions.json`, which applies to every profile in that project.
 * `session` is what the user decided during this task — an `allow_session`
 * approval — and it wins because it is the most recent and most specific
 * statement of intent there is.
 *
 * There are deliberately **no hard floors**. Hyperion is a single-user tool on
 * the user's own machine; a permission the user has explicitly granted in their
 * own project file is not something this code should second-guess. The one
 * exception is `inherited`, which is not a user preference but a subagent
 * ceiling: a parent's `deny` is evaluated after everything else and cannot be
 * overridden downward, because otherwise a Plan-mode parent could delegate its
 * way to a writable child.
 *
 * ## Why the verdict carries its provenance
 *
 * A refusal a user cannot locate is a refusal they route around by widening the
 * broadest rule they can find. `PermissionVerdict` therefore names the layer, the
 * pattern and the key that decided, and that string is written into
 * `task_steps.provenance` — so "why did it refuse?" is answerable after the run,
 * from the database, without re-running anything.
 *
 * ## Two decisions worth stating outright
 *
 * **An unknown tool is denied.** `loop.ts` already folds an unclassified tool
 * into `mutate` and explains why: defaulting the other way means any tool added
 * without touching the policy silently becomes runnable. The same argument
 * applies with more force here, because this layer can grant more than Plan mode
 * ever could.
 *
 * **A write whose path or content looks like a credential is downgraded from
 * `allow` to `ask`.** This is not gated on `redaction_check_enabled`: that toggle
 * governs *outbound egress* (`services/safety/outbound.ts`), where the risk is a
 * key leaving the machine, and it defaults off because a false positive there
 * interrupts a send. Here the risk is a key being written *into the user's source
 * tree*, where a false positive costs one confirmation and a false negative gets
 * committed. Different trade-off, different default.
 */

import { findSensitive } from '../../util/redact.ts';
import { compileGlob, normalizeGlob } from '../../util/glob.ts';
import { AppError } from '../../util/errors.ts';

import type {
  PermissionAction,
  PermissionLayer,
  PermissionRule,
  PermissionVerdict,
  ToolCall,
} from '../../types/core.ts';
import type { ToolEffect } from './loop.ts';

export type PermissionRules = Record<string, PermissionRule>;

/** One layer's contribution, in evaluation order. */
export interface PermissionLayerInput {
  layer: PermissionLayer;
  rules: PermissionRules;
}

/**
 * The catch-all key. A rule under `*` answers for any tool with no rule of its
 * own — which is how the `act` built-in says "allow everything" in one line
 * instead of enumerating a tool set it cannot know.
 */
export const ANY_TOOL = '*';

/**
 * Effect-qualified catch-alls: `*:read` and `*:mutate`.
 *
 * These exist because the three built-in profiles cannot name tools. Plan mode's
 * rule is "run anything that only reads, refuse anything that changes something",
 * and the set of tools on each side of that line is different for Code, for
 * Cowork, and for whatever MCP servers the user has configured — it is knowable
 * only through the agent's own `ToolPolicy`. Enumerating names in a built-in
 * would have silently denied `wigolo.search` in Plan mode the moment Cowork
 * started using the engine, which is a behaviour regression disguised as a
 * config default.
 *
 * They are ordinary keys, usable in a user's own profile, and they bind more
 * tightly than `*` and less tightly than an exact tool name.
 */
export const ANY_READ = '*:read';
export const ANY_MUTATE = '*:mutate';

/**
 * Key precedence inside one layer, most specific first.
 *
 * Precedence is per-layer rather than global on purpose: a project file that
 * says `{"*": "deny"}` must be able to shut off a tool the profile allowed by
 * name, because the project layer is the later statement. Making an exact name
 * beat a later layer's catch-all would mean the broader, later rule silently did
 * nothing.
 */
function candidateKeys(key: string, effect: ToolEffect): string[] {
  return [key, effect === 'read' ? ANY_READ : ANY_MUTATE, ANY_TOOL];
}

/**
 * Tools whose primary argument is a filesystem path, and which can therefore
 * write something into the project.
 *
 * `restore` counts: it puts a previous snapshot back on disk, so a credential
 * that was committed to a snapshot can be re-materialised by it.
 */
const WRITE_CAPABLE = new Set(['write', 'restore']);

/**
 * Which argument a glob is matched against, per tool.
 *
 * A path for the file tools, the command line for `bash`, the declared selector
 * for `command`. Anything unlisted matches against the raw argument JSON, which
 * is a deliberately blunt fallback: it will not match a useful glob, so an
 * unlisted tool is effectively governed by its scalar rule only. That is the
 * right failure — a wrong guess about which field matters would silently apply a
 * path rule to something that is not a path.
 */
const PRIMARY_ARGUMENT: Record<string, string> = {
  read: 'path',
  write: 'path',
  restore: 'path',
  bash: 'command',
  command: 'selector',
};

/**
 * Turn a dotted MCP wire name into a permission key: `wigolo.search` →
 * `wigolo_search`.
 *
 * Derived rather than renamed. The wire name is what the MCP server answers to
 * and what `cowork/agent.ts` dispatches on; renaming it to suit a permission file
 * would break the dispatch for no benefit. A key is a different namespace with a
 * different constraint — it has to be writable in a JSON object key and a
 * front-matter scalar without quoting surprises — so it gets its own spelling.
 */
export function permissionKey(toolName: string): string {
  return toolName.includes('.') ? toolName.replace(/\./g, '_') : toolName;
}

/**
 * The value a glob is matched against for this call.
 *
 * Returns `null` when there is nothing sensible to match, which makes a map rule
 * inapplicable rather than making it match everything.
 */
export function primaryArgument(call: ToolCall): string | null {
  const field = PRIMARY_ARGUMENT[call.name];
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    // A model that emitted malformed JSON has not named a path, and treating the
    // broken text as one could match a glob by accident. The scalar rule decides.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const args = parsed as Record<string, unknown>;

  if (field !== undefined) {
    const value = args[field];
    return typeof value === 'string' && value !== '' ? value : null;
  }

  // `delegate` takes prose, not a path. Batch form (1.28 §3) puts it in
  // `prompts[0]`; the single form keeps `prompt`.
  if (call.name === 'delegate') {
    const prompts = args.prompts;
    if (Array.isArray(prompts)) {
      const first = prompts[0];
      return typeof first === 'string' && first !== '' ? first : null;
    }
    const prompt = args.prompt;
    return typeof prompt === 'string' && prompt !== '' ? prompt : null;
  }

  return null;
}

interface RuleMatch {
  action: PermissionAction;
  pattern: string | null;
}

/**
 * Apply one layer's rules to one call.
 *
 * `undefined` means the layer said nothing and evaluation falls through. That is
 * distinct from a layer that matched and answered `allow`, which stops the
 * fall-through — the difference between "no opinion" and "yes".
 */
function matchLayer(
  rules: PermissionRules,
  key: string,
  effect: ToolEffect,
  subject: string | null,
): RuleMatch | undefined {
  for (const candidate of candidateKeys(key, effect)) {
    const rule = rules[candidate];
    if (rule === undefined) continue;
    if (typeof rule === 'string') return { action: rule, pattern: candidate === key ? null : candidate };

    // A map rule needs something to match. Longest pattern first, so a specific
    // `src/**` beats a `*` in the same object regardless of key order — object
    // key order is an authoring accident, not a precedence declaration.
    if (subject === null) continue;
    const normalizedSubject = subject.replace(/\\/g, '/');
    const patterns = Object.keys(rule).sort((a, b) => b.length - a.length);
    for (const pattern of patterns) {
      const action = rule[pattern];
      if (action === undefined) continue;
      if (pattern === ANY_TOOL || compileGlob(normalizeGlob(pattern, 'permissions')).test(normalizedSubject)) {
        return { action, pattern };
      }
    }
  }
  return undefined;
}

export interface EvaluateInput {
  call: ToolCall;
  /**
   * The agent's own classification of the tool, already folded so that an
   * unclassified tool is `mutate` — `loop.ts` explains why that direction is the
   * only safe default.
   */
  effect: ToolEffect;
  /** In evaluation order. `inherited`, when present, must come last. */
  layers: readonly PermissionLayerInput[];
  /** Tool names the agent actually registered. An unlisted name is denied. */
  knownTools: ReadonlySet<string>;
}

/**
 * The text a write-capable call would put on disk.
 *
 * Read from the arguments here rather than passed in by the caller, because a
 * caller that forgets to pass it gets a silently weaker check — and the whole
 * point of the downgrade is that it cannot be skipped.
 */
function writeContent(call: ToolCall): string {
  if (!WRITE_CAPABLE.has(call.name)) return '';
  try {
    const parsed = JSON.parse(call.arguments) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '';
    const content = (parsed as Record<string, unknown>).content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

/**
 * Decide one call.
 *
 * Falls through the layers in order, keeping the last layer that had an opinion.
 * Nothing having an opinion is a `deny` from `builtin`: this function never
 * returns "no answer", because a caller with no answer has to invent one.
 */
export function evaluate(input: EvaluateInput): PermissionVerdict {
  const key = permissionKey(input.call.name);

  if (!input.knownTools.has(input.call.name)) {
    return { action: 'deny', layer: 'builtin', pattern: null, key };
  }

  const subject = primaryArgument(input.call);
  let verdict: PermissionVerdict = { action: 'deny', layer: 'builtin', pattern: null, key };

  for (const { layer, rules } of input.layers) {
    const matched = matchLayer(rules, key, input.effect, subject);
    if (matched === undefined) continue;
    // The inherited ceiling only ever tightens. A parent that denied something
    // cannot have that reversed by a child's own profile — which is the whole
    // point of projecting denials downward and not allow-lists.
    if (layer === 'inherited' && matched.action === 'allow') continue;
    verdict = { action: matched.action, layer, pattern: matched.pattern, key };
  }

  if (verdict.action === 'allow' && WRITE_CAPABLE.has(input.call.name)) {
    const suspect = [subject ?? '', writeContent(input.call)].join('\n');
    if (findSensitive(suspect).length > 0) {
      // Deliberately keeps the matched layer and pattern: the user asked for this
      // to be allowed and is entitled to see that their rule was honoured and
      // then overridden by a finding, rather than being told the rule failed.
      return { ...verdict, action: 'ask' };
    }
  }

  return verdict;
}

/**
 * Bind a layer stack to a resolver the loop can call per tool call.
 *
 * The stack is assembled once per run, not per call: the project file is read at
 * the start of a task and the session rules are re-read on continuation, so
 * rebuilding them mid-loop would buy nothing and put a file read on the hot path.
 */
export function createPermissionResolver(input: {
  layers: readonly PermissionLayerInput[];
  knownTools: ReadonlySet<string>;
}): (call: { call: ToolCall; effect: ToolEffect }) => PermissionVerdict {
  return ({ call, effect }) =>
    evaluate({ call, effect, layers: input.layers, knownTools: input.knownTools });
}

/** A one-line, loggable statement of who decided and how. */
export function describeVerdict(verdict: PermissionVerdict): string {
  const where = verdict.pattern === null ? verdict.layer : `${verdict.layer}:${verdict.pattern}`;
  return `${verdict.action} (${where}) for ${verdict.key}`;
}

// --- parsing -----------------------------------------------------------------

const RULE_KEY_MAX = 128;
const RULES_MAX = 200;

function isAction(value: unknown): value is PermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

/**
 * Validate an untrusted permission block.
 *
 * Used for both `.hyperion/permissions.json` and a profile's front-matter JSON
 * (D15), because they are the same shape and a user who learned one should not
 * have to learn the other. Rejects rather than repairing: a malformed rule that
 * was silently dropped would present as a permission the user believes they
 * granted and did not.
 *
 * `field` names the source so the error points at the file to fix.
 */
export function parsePermissionRules(value: unknown, field: string): PermissionRules {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('bad_request', 'A permissions block must be a JSON object.', {
      details: { field },
    });
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > RULES_MAX) {
    throw new AppError('bad_request', `A permissions block may declare at most ${RULES_MAX} rules.`, {
      details: { field },
    });
  }

  const out: PermissionRules = {};
  for (const [key, rule] of entries) {
    if (key === '' || key.length > RULE_KEY_MAX) {
      throw new AppError('bad_request', 'A permission key must be a short non-empty string.', {
        details: { field, key },
      });
    }
    if (isAction(rule)) {
      out[key] = rule;
      continue;
    }
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new AppError(
        'bad_request',
        `Permission "${key}" must be "allow", "ask", "deny", or a map of glob to one of those.`,
        { details: { field, key } },
      );
    }
    const map: Record<string, PermissionAction> = {};
    for (const [pattern, action] of Object.entries(rule as Record<string, unknown>)) {
      if (!isAction(action)) {
        throw new AppError('bad_request', `Permission "${key}" maps "${pattern}" to an unknown action.`, {
          details: { field, key, pattern },
        });
      }
      // Validate the glob at parse time rather than at the first call it governs:
      // a broken pattern discovered mid-run is a broken pattern discovered after
      // the agent already started working.
      if (pattern !== ANY_TOOL) normalizeGlob(pattern, field);
      map[pattern] = action;
    }
    out[key] = map;
  }
  return out;
}

/** Parse a JSON permissions block written as one front-matter scalar (D15). */
export function parsePermissionScalar(raw: string, field: string): PermissionRules {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AppError(
      'bad_request',
      'A profile permissions: block must be valid JSON on one line, e.g. {"bash":"ask"}.',
      { details: { field } },
    );
  }
  return parsePermissionRules(value, field);
}
