/**
 * The in-flight process registry (S3).
 *
 * A single-shot `executeCommand` is a process nobody owns. It is spawned inside
 * the executor's promise, its pid is handed to `killProcessTree` and then
 * forgotten, and its output exists only as the string the promise resolves with.
 * That is fine while the call is awaited, and wrong the moment anything else wants
 * to look at a running command: a status read, a cancellation from another code
 * path, or an audit of what the machine was asked to run.
 *
 * So every execution the terminal starts is registered here for its lifetime. The
 * entry binds what the process *is* — an opaque server-generated id, the OS pid,
 * the task and run that asked, the canonical worktree it runs in, the exact
 * command, its start and finish timestamps, its lifecycle state, and its output —
 * and it binds who may touch it: reads, status and abort all require the ownership
 * token minted with the entry.
 *
 * Five decisions, each of which could have gone the other way:
 *
 *   - **The id and the token are both generated here.** Neither is accepted from
 *     the caller, so there is no code path on which a client names a process. The
 *     id is for talking *about* a process (it appears in lists and errors); the
 *     token is for touching one (`abort`). `list` strips the token, so the
 *     situation the token exists for is precisely the one a list result creates:
 *     somebody holding an id and nothing else.
 *   - **Ownership is checked with a timing-safe comparison** — `tokensMatch` in
 *     `security/tokens.ts`, shared with the interactive-session token (S17) so the
 *     two cannot drift apart. Token length is not secret, so a length mismatch is
 *     answered without comparing.
 *   - **A wrong or missing token is `not_found`, and the message is the same one a
 *     nonexistent id gets.** Answering `forbidden` would confirm that the id
 *     exists, which is the one fact a caller without the token should not learn.
 *   - **Terminal states are one-way.** `running → completed | failed | aborted`,
 *     and a later write cannot move an entry again: the close event that follows an
 *     abort says nothing new, and a registry that let it overwrite `aborted` would
 *     report the recovery the abort was supposed to prevent. `aborted` covers both
 *     ways an execution is terminated rather than finishing — a cancellation and a
 *     timeout — with `timedOut` kept beside it so the two remain distinguishable.
 *   - **Finished entries are retained, bounded, oldest first.** A registry that
 *     never forgets is a leak, and one that forgets immediately cannot answer "what
 *     ran, and what happened to it?". The cap is on *finished* entries only, so a
 *     long-running command is never evicted by the churn around it.
 *
 * Deliberately not a supervisor: nothing here restarts, schedules, or watches a
 * process, and nothing polls. It is the bookkeeping the existing single-shot
 * invocations were missing (S3 is bounded to what exists).
 */
import { randomUUID } from 'node:crypto';

import { AppError } from '../../util/errors.ts';
import { mintToken, tokensMatch } from '../../security/tokens.ts';

/** Bound on one stream's retained bytes. Matches the terminal's own cap. */
const MAX_OUTPUT_BYTES = 256 * 1024;
const TRUNCATION_MARKER = '\n[output truncated after 262144 bytes]\n';
/** How many finished entries are kept. Running entries are never evicted. */
const RETAINED_FINISHED = 200;

export type ProcessStream = 'stdout' | 'stderr';

/** Where a process is in its life. Only `running` can be read as "still going". */
export type ProcessState = 'running' | 'completed' | 'failed' | 'aborted';

export interface ProcessEntry {
  /** Opaque, server-generated. Safe to show a user; useless without the token. */
  id: string;
  /** The OS pid, or null when the spawn never produced one. */
  pid: number | null;
  /** Null for the one execution path with no task: `POST /code/execute-command`. */
  taskId: string | null;
  /** Null for a headless or route-level execution, exactly as elsewhere. */
  runId: string | null;
  /**
   * The live interactive session whose human launched this, when one did (S17).
   *
   * Null for everything an agent or an unevaluated client started. It is on the
   * entry because "which of these was typed by a person" is the question this
   * registry is in a position to answer, and the answer belongs beside the command
   * rather than in a log line that has already rotated.
   */
  sessionId: string | null;
  /** The canonical cwd the command runs in. */
  workspace: string;
  /** Verbatim, as the caller asked for it. */
  command: string;
  startedAt: number;
  finishedAt: number | null;
  state: ProcessState;
  exitCode: number | null;
  /** True only for a process the timeout killed, never for a caller's abort. */
  timedOut: boolean;
}

export interface RegisterInput {
  pid: number | null;
  workspace: string;
  command: string;
  taskId?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  /** Kills the process. Called by `abort`, never by `finish`. */
  terminate?: () => void;
  now?: number;
}

export interface FinishOutcome {
  state: Exclude<ProcessState, 'running'>;
  exitCode?: number | null;
  timedOut?: boolean;
  now?: number;
}

export interface ProcessSnapshot {
  process: ProcessEntry;
  stdout: string;
  stderr: string;
}

export interface ProcessRegistry {
  /** Mint an id and a token for a process that has just started. */
  register(input: RegisterInput): { id: string; token: string };
  /** Retain a chunk of output. Bounded per stream; extra bytes are dropped. */
  append(id: string, token: string, stream: ProcessStream, chunk: Buffer | string): void;
  /** Record the terminal state. One-way: never moves a settled entry. */
  finish(id: string, token: string, outcome: FinishOutcome): ProcessEntry;
  /** The entry and its output, for a caller holding the token. */
  read(id: string, token: string): ProcessSnapshot;
  /** The entry alone, for a caller holding the token. */
  status(id: string, token: string): ProcessEntry;
  /** Terminate a running process. Returns false when it had already finished. */
  abort(id: string, token: string): boolean;
  /** Every entry, newest first, **without** any token. */
  list(): ProcessEntry[];
}

/** A fixed-capacity byte buffer, so a chatty process cannot exhaust memory. */
class ByteBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;

  append(chunk: Buffer): void {
    if (this.truncated) return;
    const remaining = MAX_OUTPUT_BYTES - this.size;
    if (chunk.length <= remaining) {
      this.chunks.push(chunk);
      this.size += chunk.length;
      return;
    }
    if (remaining > 0) this.chunks.push(chunk.subarray(0, remaining));
    this.size = MAX_OUTPUT_BYTES;
    this.truncated = true;
  }

  toString(): string {
    const content = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${content}${TRUNCATION_MARKER}` : content;
  }
}

interface Record_ {
  entry: ProcessEntry;
  token: string;
  stdout: ByteBuffer;
  stderr: ByteBuffer;
  terminate?: () => void;
}

export function createProcessRegistry(): ProcessRegistry {
  const records = new Map<string, Record_>();

  /**
   * The one way in. A miss and a foreign token are answered identically, because
   * "this id exists but is not yours" is information the token exists to withhold.
   */
  function requireOwned(id: unknown, token: unknown): Record_ {
    const record = typeof id === 'string' ? records.get(id) : undefined;
    if (record === undefined || !tokensMatch(record.token, token)) {
      throw new AppError('not_found', 'No in-flight process with that id belongs to this caller.', {
        details: { processId: typeof id === 'string' ? id : null },
      });
    }
    return record;
  }

  /** Copies, so a caller holding an entry cannot reach back into the registry. */
  function view(entry: ProcessEntry): ProcessEntry {
    return { ...entry };
  }

  function evictFinished(): void {
    if (records.size <= RETAINED_FINISHED) return;
    const finished = [...records.values()].filter((record) => record.entry.state !== 'running');
    // Map iteration is insertion order, so this drops the oldest finishes first.
    for (const record of finished) {
      if (records.size <= RETAINED_FINISHED) break;
      records.delete(record.entry.id);
    }
  }

  return {
    register(input) {
      const now = input.now ?? Date.now();
      const id = `proc_${randomUUID()}`;
      const token = mintToken();
      records.set(id, {
        entry: {
          id,
          pid: input.pid,
          taskId: input.taskId ?? null,
          runId: input.runId ?? null,
          sessionId: input.sessionId ?? null,
          workspace: input.workspace,
          command: input.command,
          startedAt: now,
          finishedAt: null,
          state: 'running',
          exitCode: null,
          timedOut: false,
        },
        token,
        stdout: new ByteBuffer(),
        stderr: new ByteBuffer(),
        ...(input.terminate === undefined ? {} : { terminate: input.terminate }),
      });
      evictFinished();
      return { id, token };
    },

    append(id, token, stream, chunk) {
      const record = requireOwned(id, token);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      (stream === 'stdout' ? record.stdout : record.stderr).append(bytes);
    },

    finish(id, token, outcome) {
      const record = requireOwned(id, token);
      // Already settled: a close event after an abort says nothing new.
      if (record.entry.state !== 'running') return view(record.entry);
      record.entry.state = outcome.state;
      record.entry.exitCode = outcome.exitCode ?? null;
      record.entry.timedOut = outcome.timedOut ?? false;
      record.entry.finishedAt = outcome.now ?? Date.now();
      record.terminate = undefined;
      return view(record.entry);
    },

    read(id, token) {
      const record = requireOwned(id, token);
      return { process: view(record.entry), stdout: record.stdout.toString(), stderr: record.stderr.toString() };
    },

    status(id, token) {
      return view(requireOwned(id, token).entry);
    },

    abort(id, token) {
      const record = requireOwned(id, token);
      // Racing a process that just exited is not an error: the caller asked for it
      // to be over, and it is. Nothing to terminate, nothing to record.
      if (record.entry.state !== 'running') return false;
      record.entry.state = 'aborted';
      record.entry.finishedAt = Date.now();
      record.terminate?.();
      record.terminate = undefined;
      return true;
    },

    list() {
      return [...records.values()].map((record) => view(record.entry)).reverse();
    },
  };
}

/**
 * The process registry the terminal module uses.
 *
 * A module singleton rather than a parameter, because the alternative — each
 * caller constructing its own — would produce registries that cannot answer "what
 * is running on this machine?", which is the only question worth asking of it.
 */
export const processRegistry = createProcessRegistry();
