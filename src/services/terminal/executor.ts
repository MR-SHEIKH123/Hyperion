/**
 * Local shell execution for agent tools.
 *
 * The orchestrator owns capability and filesystem policy. This module owns the
 * process lifecycle after those checks have passed: shell selection, bounded
 * output, timeout handling, and terminating descendants left by a command.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { AppError } from '../../util/errors.ts';
import type { CommandResult, TerminalModule } from '../../types/core.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_EXIT_CODE = 124;
const TRUNCATION_MARKER = '\n[output truncated after 262144 bytes]\n';
const KILL_GRACE_MS = 2_000;

class OutputBuffer {
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

export function createTerminalModule(): TerminalModule {
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
        const stdout = new OutputBuffer();
        const stderr = new OutputBuffer();

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
          if (child !== undefined) killProcessTree(child);
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

        child.stdout?.on('data', (chunk: Buffer | string) => {
          stdout.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.once('error', (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new AppError('internal_error', 'The terminal process could not be started.', {
            privateDetails: { cause: error.message },
            cause: error,
          }));
        });
        child.once('close', (exitCode: number | null) => {
          if (settled) return;
          finish({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: timedOut ? TIMEOUT_EXIT_CODE : (exitCode ?? 1),
            timedOut,
          });
        });

        timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          killProcessTree(child);
          forceKillTimer = setTimeout(() => {
            if (settled) return;
            child.kill('SIGKILL');
            finish({
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              exitCode: TIMEOUT_EXIT_CODE,
              timedOut: true,
            });
          }, KILL_GRACE_MS);
        }, timeoutMs);
      });
    },
  };
}

export const terminalModule = createTerminalModule();