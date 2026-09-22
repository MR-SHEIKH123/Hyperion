/**
 * The plugin catalogue (Prompt 1.34).
 *
 * A plugin in Hyperion is not a fifth kind of thing: it is one of the things that
 * already exist and that a tool may or may not be allowed to use — an MCP server,
 * a skill, or a built-in capability. This module *composes* those registries and
 * adds the two facts that had nowhere to live: who may use a plugin (durable,
 * migration `025`) and what a plugin is, read statically and offline, as a grade
 * rather than a verdict.
 *
 * Three rules hold the shape together:
 *
 *   1. **The catalogue owns no state of its own about a plugin's content.** A
 *      server's command, a skill's flags come from the registry that stores them.
 *      Two sources for one fact is how a hub starts lying about the thing it is
 *      supposed to make legible.
 *   2. **`enabled` and `availability` are different questions**, and both are
 *      reported. `enabled` is the plugin's own switch (the server is configured
 *      and turned on); `availability` is per tool (Chat may use it, Code may
 *      not). A hub that collapsed them would make "off everywhere" and "off for
 *      one tool" the same row.
 *   3. **`consumers` is a fact about the code, not a promise.** It names the tools
 *      whose code reads this plugin *today*. Three of the four tools cannot
 *      consume an MCP server yet, and saying so is the point: an availability
 *      switch that appears to gate something that does not exist would be worse
 *      than no switch.
 */
import { TOOLS, type ToolName } from '../../types/core.ts';
import { listPluginAvailability, prunePluginAvailability, setPluginAvailability } from '../../db/plugins.ts';
import { listServers } from '../mcp/registry.ts';
import { listSkills } from '../skills/registry.ts';
import { memoryEnabled } from '../memory/index.ts';
import {
  MEMORY_PLUGIN_ID,
  availabilityMap,
  mcpPluginId,
  skillPluginId,
  type PluginKind,
} from './availability.ts';

/**
 * The caveat that travels with every scan, on every plugin, in every response.
 *
 * Same promise the skill risk scan makes — a heuristic reading, never a verdict —
 * widened to the two things a plugin can be that a file cannot: a command that
 * runs on this machine, and an endpoint it talks to.
 */
export const SCAN_DISCLAIMER =
  'This is a static, offline reading of what a plugin contains and how it is configured. It ' +
  'looks for a small set of obvious signals and cannot produce a verdict: a quiet grade means ' +
  'nothing obvious was found, never that the plugin is safe, and a loud one names what was ' +
  'found rather than what it would do.';

/**
 * What the scan concluded, in three levels.
 *
 * `builtin` is not a rank above `inert`: it is a different statement. Hyperion's own
 * content is not scanned by policy (the same exemption `riskscan.ts` makes), so the
 * grade says where the plugin came from, and the summary says that in words.
 */
export type ScanGrade = 'builtin' | 'inert' | 'active';

export interface PluginFinding {
  code: string;
  severity: 'info' | 'warning';
  message: string;
}

export interface PluginScan {
  grade: ScanGrade;
  /** One sentence saying what the grade is about. Rendered next to it. */
  summary: string;
  findings: PluginFinding[];
  disclaimer: string;
}

export interface PluginEntry {
  id: string;
  kind: PluginKind;
  name: string;
  description: string;
  /** Where it came from — an MCP transport, a skill's source type, or 'builtin'. */
  source: string;
  /** The plugin's own switch, not who may use it. */
  enabled: boolean;
  /** Tools whose code reads this plugin today. */
  consumers: ToolName[];
  availability: Record<ToolName, boolean>;
  /** When any availability override was last changed; null when all are defaults. */
  availabilityUpdatedAt: number | null;
  scan: PluginScan;
}

export interface PluginCatalogue {
  plugins: PluginEntry[];
  /** The tools an availability answer can be given for. */
  tools: readonly ToolName[];
  /** Overrides whose plugin no longer exists (reported; pruned by the next write). */
  orphanedAvailability: number;
  disclaimer: string;
}

/**
 * Cowork is the only tool whose code consumes an MCP server, and it consumes one
 * by name (`WIGOLO_NAME` in `services/cowork/agent.ts`). A second server is
 * therefore *not* consumed by anything yet — reported as such rather than
 * claiming a consumer that does not read it.
 */
const COWORK_MCP_SERVER = 'wigolo';

/**
 * The tools that receive the skills summary: the three agent loops build their
 * context through `orchestrator/agentContext.ts`. Chat does not — it has no skills
 * block — which is why it is absent rather than listed for symmetry.
 */
const SKILL_CONSUMERS: readonly ToolName[] = ['code', 'cowork', 'design'];

/**
 * Memory's consumers. The chat orchestrator recalls and remembers with the
 * *chat's own tool*, so any conversation surface reaches it (that is 'chat' and
 * 'playground' here); Cowork calls the same two functions directly. A Code or
 * Design task run does not read memory.
 */
const MEMORY_CONSUMERS: readonly ToolName[] = ['chat', 'cowork', 'playground'];

/**
 * Command-line markers of a server that drives a browser.
 *
 * A browser automation server is not merely "active": it acts as the user, in
 * the user's network position, on pages the user is logged into. That is the one
 * thing a settings screen has to say out loud before someone enables it, and the
 * reading is evidence — the marker found is named in the finding — rather than a
 * verdict about any particular package.
 */
const BROWSER_AUTOMATION_MARKERS = ['browser-use', 'playwright', 'puppeteer', 'selenium', 'chromedriver'] as const;

function browserAutomationMarker(command: string | null, args: readonly string[]): string | null {
  const haystack = `${command ?? ''} ${args.join(' ')}`.toLowerCase();
  return BROWSER_AUTOMATION_MARKERS.find((marker) => haystack.includes(marker)) ?? null;
}

/** Hide `user:password@` in a stored endpoint. The value stays usable, the secret does not travel. */
function redactEndpoint(raw: string): string {
  return raw.replace(/\/\/[^/@\s]+@/, '//***@');
}

/** The folded availability of one plugin: the map plus when it was last changed. */
interface FoldedAvailability {
  availability: Record<ToolName, boolean>;
  updatedAt: number | null;
}

function entry(params: {
  id: string;
  kind: PluginKind;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  consumers: readonly ToolName[];
  scan: PluginScan;
  overrides: Map<string, FoldedAvailability>;
}): PluginEntry {
  const folded = params.overrides.get(params.id) ?? availabilityMap([]);
  return {
    id: params.id,
    kind: params.kind,
    name: params.name,
    description: params.description,
    source: params.source,
    enabled: params.enabled,
    consumers: [...params.consumers],
    availability: folded.availability,
    availabilityUpdatedAt: folded.updatedAt,
    scan: params.scan,
  };
}

function scanOf(grade: ScanGrade, summary: string, findings: PluginFinding[]): PluginScan {
  return { grade, summary, findings, disclaimer: SCAN_DISCLAIMER };
}

/**
 * Read every plugin Hyperion knows about, with availability folded in.
 *
 * No network, no process spawn, no file read beyond what the skill registry
 * already stored at intake. A hub read happens on a settings screen; anything
 * that could take a second belongs behind an action.
 */
export function listPlugins(): PluginCatalogue {
  // One fold per plugin id, so an empty table and a table full of defaults read
  // the same and the fold itself lives in `availability.ts` only.
  const rows = listPluginAvailability();
  const overrides = new Map<string, FoldedAvailability>();
  for (const pluginId of new Set(rows.map((row) => row.pluginId))) {
    overrides.set(
      pluginId,
      availabilityMap(rows.filter((row) => row.pluginId === pluginId)),
    );
  }

  const plugins: PluginEntry[] = [];
  const live = new Set<string>();

  for (const server of listServers()) {
    const id = mcpPluginId(server.id);
    live.add(id);
    const findings: PluginFinding[] = [];
    let source: string;
    if (server.type === 'local') {
      source = 'mcp · local';
      findings.push({
        code: 'mcp.local-command',
        severity: 'warning',
        message: `Runs \`${server.command ?? '(no command)'}\` with ${server.args.length} argument(s) on this machine when it is started.`,
      });
    } else {
      source = 'mcp · remote';
      findings.push({
        code: 'mcp.remote-endpoint',
        severity: 'warning',
        message: `Talks to ${redactEndpoint(server.url ?? '(no url)')}.`,
      });
    }
    if (server.tokenEnc !== null) {
      findings.push({
        code: 'mcp.stored-credential',
        severity: 'info',
        message: 'Holds a stored credential. The value never leaves the backend; only its hint is readable.',
      });
    }
    const browserMarker =
      server.type === 'local' ? browserAutomationMarker(server.command, server.args) : null;
    if (browserMarker !== null) {
      findings.push({
        code: 'mcp.browser-automation',
        severity: 'warning',
        message:
          `Browser automation (\`${browserMarker}\` appears in its command): it drives a real browser — ` +
          'visiting pages, clicking, typing and downloading as this machine, on any site this machine is ' +
          'signed in to. It also runs its own model loop, so it needs a credential of its own.',
      });
    }
    const envKeys = Object.keys(server.env);
    if (envKeys.length > 0) {
      findings.push({
        code: 'mcp.environment',
        severity: 'info',
        message: `Declares ${envKeys.length} environment variable(s) for the server process.`,
      });
    }
    findings.push({
      code: 'mcp.disabled-not-stopped',
      severity: 'info',
      message: server.enabled
        ? 'Enabled: the supervisor may start it. Nothing here runs until it does.'
        : 'Disabled: the supervisor will not start it. Disabling stops new starts, it does not uninstall anything.',
    });

    plugins.push(
      entry({
        id,
        kind: 'mcp',
        name: server.name,
        description:
          server.type === 'local'
            ? `MCP server that runs locally: ${server.command ?? '(no command)'}`
            : `MCP server reached over the network: ${redactEndpoint(server.url ?? '(no url)')}`,
        source,
        enabled: server.enabled,
        consumers: server.name.toLowerCase() === COWORK_MCP_SERVER ? ['cowork'] : [],
        scan: scanOf('active', 'This plugin can act: it runs a command or talks to an endpoint.', findings),
        overrides,
      }),
    );
  }

  for (const skill of listSkills()) {
    const id = skillPluginId(skill.id);
    live.add(id);
    const findings: PluginFinding[] = skill.riskFlags.map((flag) => ({
      code: `skill.${flag.category}`,
      severity: flag.severity,
      message: flag.line === undefined ? `${flag.file}: ${flag.message}` : `${flag.file}:${flag.line}: ${flag.message}`,
    }));
    plugins.push(
      entry({
        id,
        kind: 'skill',
        name: skill.name,
        description: skill.description ?? 'No description recorded.',
        source: `skill · ${skill.sourceType}`,
        enabled: skill.enabled,
        consumers: SKILL_CONSUMERS,
        scan:
          findings.length === 0
            ? scanOf('inert', 'Files and instructions; the scan found nothing that acts.', findings)
            : scanOf('active', `The scan flagged ${findings.length} signal(s) in this skill's files.`, findings),
        overrides,
      }),
    );
  }

  live.add(MEMORY_PLUGIN_ID);
  plugins.push(
    entry({
      id: MEMORY_PLUGIN_ID,
      kind: 'builtin',
      name: 'Memory',
      description: 'Stores facts from conversations and recalls them into later turns. Off until it is switched on.',
      source: 'builtin',
      enabled: memoryEnabled(),
      consumers: MEMORY_CONSUMERS,
      scan: scanOf(
        'builtin',
        "Ships with Hyperion. The heuristic scan is not run on Hyperion's own content, so this grade is about provenance, not safety.",
        [],
      ),
      overrides,
    }),
  );

  const orphanedAvailability = rows.filter((row) => !live.has(row.pluginId)).length;

  plugins.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));

  return { plugins, tools: TOOLS, orphanedAvailability, disclaimer: SCAN_DISCLAIMER };
}

/** One plugin, or null. Used by the availability write to refuse an unknown subject. */
export function findPlugin(id: string): PluginEntry | null {
  return listPlugins().plugins.find((plugin) => plugin.id === id) ?? null;
}

/**
 * Record a per-tool availability decision and return the updated plugin.
 *
 * The write also prunes overrides whose plugin is gone: this is the only path
 * that mutates the table, and a read that deleted rows would be a GET that can
 * fail on a read-only database. The prune is reported back so the caller can see
 * that debris was cleared rather than wondering why the count moved.
 */
export function setPluginAvailabilityFor(
  id: string,
  tool: ToolName,
  available: boolean | null,
): { plugin: PluginEntry; pruned: number } | null {
  const live = listPlugins();
  if (!live.plugins.some((plugin) => plugin.id === id)) return null;
  setPluginAvailability(id, tool, available);
  const pruned = prunePluginAvailability(live.plugins.map((plugin) => plugin.id));
  const updated = findPlugin(id);
  return updated === null ? null : { plugin: updated, pruned };
}
