/**
 * Local shell execution for agent tools.
 *
 * The orchestrator owns capability and filesystem policy. This module owns the
 * process lifecycle after those checks have passed: shell selection, bounded
 * output, timeout handling, and terminating descendants left by a command.
 *
 * Every execution is registered with the process registry for its lifetime (S3),
 * which is where its output now lives: the buffers belong to the entry, and this
 * module reads them back through the ownership token it was handed at
 * registration. That is deliberate rather than convenient — a second copy of the
 * output here would be a second truth about what a running command has printed,
 * and the entry is the one an audit or a status read is going to look at.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { AppError } from '../../util/errors.ts';
import type { CommandResult, TerminalModule } from '../../types/core.ts';
import { processRegistry, type ProcessRegistry } from './registry.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const TIMEOUT_EXIT_CODE = 124;
const KILL_GRACE_MS = 2_000;

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: process.env.SHELL || '/bin/sh', args: ['-c', command] };
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/f', '/t', '/pid', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
    let finished = false;
    const fallback = (): void => {
      if (finished) return;
      finished = true;
      killer.kill('SIGKILL');
      child.kill('SIGKILL');
      clearTimeout(fallbackTimer);
    };
    const fallbackTimer = setTimeout(fallback, KILL_GRACE_MS);
    killer.once('error', fallback);
    killer.once('close', (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(fallbackTimer);
      if (exitCode !== 0) child.kill('SIGKILL');
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function timeoutFrom(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new AppError('bad_request', 'timeoutMs must be a positive integer.', {
      details: { field: 'timeoutMs' },
    });
  }
  return timeoutMs;
}

/**
 * The registry is injectable so a test can hold the tokens the module keeps to
 * itself. Production takes the module singleton.
 */
export function createTerminalModule(options: { registry?: ProcessRegistry } = {}): TerminalModule {
  const registry = options.registry ?? processRegistry;

  return {
    executeCommand(cwd, command, options): Promise<CommandResult> {
      const timeoutMs = timeoutFrom(options?.timeoutMs);
      if (options?.signal?.aborted) {
        return Promise.reject(new AppError('aborted', 'Command execution was cancelled.', { retryable: false }));
      }
      const { file, args } = shellInvocation(command);

      return new Promise<CommandResult>((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        let forceKillTimer: NodeJS.Timeout | undefined;
        let child: ChildProcess | undefined;
        let execution: { id: string; token: string } | undefined;

        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
          options?.signal?.removeEventListener('abort', abort);
        };

        const finish = (result: CommandResult): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };

        const abort = (): void => {
          if (settled) return;
          // The entry moves to `aborted` before the signal is sent, so a close
          // event that races the kill cannot record the process as completed.
          if (execution !== undefined) registry.abort(execution.id, execution.token);
          else if (child !== undefined) killProcessTree(child);
          settled = true;
          cleanup();
          reject(new AppError('aborted', 'Command execution was cancelled.', { retryable: false }));
        };

        options?.signal?.addEventListener('abort', abort);
        if (options?.signal?.aborted) {
          abort();
          return;
        }

        try {
          child = spawn(file, args, {
            cwd,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) {
          settled = true;
          cleanup();
          reject(new AppError('internal_error', 'The terminal process could not be started.', {
            privateDetails: { cause: error instanceof Error ? error.message : String(error) },
            cause: error,
          }));
          return;
        }

        // Registered in the same tick as a successful spawn: the process exists
        // before this line, and from this line it can be named, read and aborted.
        execution = registry.register({
          pid: child.pid ?? null,
          taskId: options?.taskId ?? null,
          runId: options?.runId ?? null,
          sessionId: options?.sessionId ?? null,
          workspace: cwd,
          command,
          terminate: () => {
            if (child !== undefined) killProcessTree(child);
          },
        });

        child.stdout?.on('data', (chunk: Buffer | string) => {
          if (execution !== undefined) registry.append(execution.id, execution.token, 'stdout', chunk);
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          if (execution !== undefined) registry.append(execution.id, execution.token, 'stderr', chunk);
        });
        child.once('error', (error: Error) => {
          if (settled) return;
          if (execution !== undefined) {
            registry.finish(execution.id, execution.token, { state: 'failed', exitCode: null });
          }
          settled = true;
          cleanup();
          reject(new AppError('internal_error', 'The terminal process could not be started.', {
            privateDetails: { cause: error.message },
            cause: error,
          }));
        });
        child.once('close', (exitCode: number | null) => {
          const active = execution;
          if (settled || active === undefined) return;
          const code = timedOut ? TIMEOUT_EXIT_CODE : (exitCode ?? 1);
          registry.finish(active.id, active.token, {
            // A process the timeout killed did not finish: it was terminated, and
            // `timedOut` keeps that distinguishable from a caller's abort.
            state: timedOut ? 'aborted' : code === 0 ? 'completed' : 'failed',
            exitCode: code,
            timedOut,
          });
          const { stdout, stderr } = registry.read(active.id, active.token);
          finish({ stdout, stderr, exitCode: code, timedOut });
        });

        timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          killProcessTree(child);
          forceKillTimer = setTimeout(() => {
            const active = execution;
            if (settled || active === undefined) return;
            registry.finish(active.id, active.token, {
              state: 'aborted',
              exitCode: TIMEOUT_EXIT_CODE,
              timedOut: true,
            });
            const { stdout, stderr } = registry.read(active.id, active.token);
            finish({ stdout, stderr, exitCode: TIMEOUT_EXIT_CODE, timedOut: true });
          }, KILL_GRACE_MS);
        }, timeoutMs);
      });
    },
  };
}

export const terminalModule = createTerminalModule();
