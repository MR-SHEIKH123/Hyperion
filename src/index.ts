/**
 * Hyperion entrypoint.
 *
 * Boot order matters: directories must exist before the database file is
 * opened, migrations must run before any repository is touched, and orphaned
 * runs (from a crash or a hard restart) must be reconciled before the HTTP
 * surface starts accepting new work.
 */
import 'dotenv/config';

import { env, ensureDirectories, migrateLegacyHome } from './config/env.ts';
import { closeDb, openDatabase, setDb } from './db/adapter.ts';
import { logError } from './db/errorLog.ts';
import { runMigrations } from './db/migrate.ts';
import { reconcileOrphanedTaskRuns } from './db/taskRuns.ts';


import { reconcileOrphanedRuns } from './orchestrator/runState.ts';
import { startBackupScheduler, stopBackupScheduler } from './services/backup/schedule.ts';
import { startTaskScheduler, stopTaskScheduler } from './services/cowork/scheduler.ts';
import { expireWaitingApprovals } from './services/agent/approvalWait.ts';
import { scanOrphanedWorktrees } from './services/code/worktree.ts';
import { seedDefaultServers } from './services/mcp/defaults.ts';
import { startMcpSupervisor, stopMcpSupervisor } from './services/mcp/supervisor.ts';
import { restoreActiveProject } from './services/projects/active.ts';
import { ensureSkillDirs } from './services/skills/intake.ts';

import {
  reapParkedWorktrees,
  startCleanupScheduler,
  stopCleanupScheduler,
} from './services/storage/cleanup.ts';
import { registerProductionModules } from './services/agent/composition.ts';
import { createApp } from './http/app.ts';
import { startPreviewServer } from './http/previewServer.ts';
import { createLogger } from './util/logger.ts';

import type { Server } from 'node:http';

const log = createLogger('boot');

function bootstrap(): void {
  // Strictly before ensureDirectories(): it creates the data root, which would
  // make "the current home does not exist yet" false and stop this from ever
  // firing. A pre-rename install would then boot into an empty home while its
  // real chats and settings sat untouched in ~/AIStudio.
  const legacy = migrateLegacyHome();
  if (legacy.migrated) {
    log.info('migrated data directory from the pre-rename location', {
      from: legacy.from,
      to: legacy.to,
      ...(legacy.renamed.length > 0 ? { renamed: legacy.renamed } : {}),
    });
  } else if (legacy.conflict) {
    log.warn(`left the legacy data directory alone: ${legacy.reason}`);
  }

  ensureDirectories();

  const db = openDatabase(env.paths.db);
  setDb(db);

  const migrations = runMigrations(db);
  if (migrations.applied.length > 0) {
    log.info('migrations applied', { applied: migrations.applied, skipped: migrations.skipped });
  }

  const orphanedChatRuns = reconcileOrphanedRuns();
  if (orphanedChatRuns > 0) {
    log.warn('reconciled orphaned chat runs from a previous process', { count: orphanedChatRuns });
  }

  const orphanedTaskRuns = reconcileOrphanedTaskRuns();
  if (orphanedTaskRuns > 0) {
    log.warn('reconciled orphaned task runs from a previous process', { count: orphanedTaskRuns });
  }

  // A wait can end while nothing is running — a deadline passes on a machine that
  // is off — so the sweep is here as well as on the cleanup timer, and it is the
  // reason a prompt cannot outlive the process that would have reaped it.
  expireWaitingApprovals();

  // Beside the reconciliation above because it answers the same question for the
  // filesystem: what did a previous process leave behind? The worktree registry is
  // in-memory, so a park from a dead process has no entry here and this pass finds
  // nothing — it exists for a park that outlived its TTL while the cleanup timer
  // was idle, and it is cheap when there is nothing held.
  void reapParkedWorktrees().catch((error: unknown) => {
    log.warn('boot worktree reap failed', { error: String(error) });
  });

  // And the same question for directories rather than holds (1.31): the worktree
  // registry is in-memory, so everything on disk at boot belongs to no task this
  // process knows about. The scan only reports — nothing here deletes — and its
  // result is what the attention queue reads instead of spawning git inside a
  // synchronous read. Runs before the server accepts work so the first
  // `GET /api/attention` has an answer.
  void scanOrphanedWorktrees()
    .then((scan) => {
      if (scan.orphans.length > 0) {
        log.warn('worktree directories from a previous process were found', {
          count: scan.orphans.length,
          holdingWork: scan.holding,
          unchecked: scan.unchecked,
        });
      }
    })
    .catch((error: unknown) => {
      log.warn('boot worktree scan failed', { error: String(error) });
    });


  ensureSkillDirs();

  // Strictly before seedDefaultServers(): the default filesystem MCP server is
  // seeded with the active project's directory as its argument, so the scope has
  // to be restored first or a fresh install would hard-code the default root
  // into a server definition that then never follows the project again.
  const active = restoreActiveProject();
  log.info(
    active === null
      ? 'no active project; filesystem scope is the default projects root'
      : `active project restored: ${active.name}`,
    active === null ? undefined : { projectId: active.id, path: active.path },
  );

  // Idempotent and marker-guarded: a default the user deletes stays deleted,
  // and an existing server of the same name is never overwritten.
  const seeded = seedDefaultServers();

  if (seeded.created.length > 0) {
    log.info('seeded default MCP servers', { created: seeded.created });
  }
}

function startServer(): Server {
  const app = createApp();
  const server = app.listen(env.port, env.host, () => {
    log.info(`listening on http://${env.host}:${env.port}`);
    if (!env.bindIsLoopback) {
      log.warn(
        `bound to non-loopback host ${env.host} — Hyperion has NO authentication. ` +
          'Use a private network (e.g. Tailscale) instead of exposing this port.',
      );
    }
  });

  server.on('error', (error: unknown) => {
    log.error('server error', error);
    process.exitCode = 1;
  });

  // SSE streams are long-lived; keep the socket timeout off so heartbeats rule.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  return server;
}

/**
 * Graceful shutdown. PM2 sends SIGINT and waits `kill_timeout` (8s) before
 * SIGKILL, so everything here is bounded well under that budget.
 */
function installShutdownHandlers(server: Server, preview: Server | null): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);

    const forceExit = setTimeout(() => {
      log.warn('shutdown timed out, exiting');
      process.exit(0);
    }, 6000);
    forceExit.unref();

    // The preview listener goes first, and it is deliberately not awaited. It
    // holds no database handle and no child process, so there is nothing to
    // flush; what it can hold is a browser parked on a preview for as long as
    // the tab is open, and `close()` does not call back until that socket ends.
    // Waiting would mean the 6 s force-exit is the only thing that ever
    // finishes a shutdown. Connections are dropped so a client notices now
    // rather than at the force-exit, and the close is left to settle on its
    // own.
    if (preview !== null) {
      preview.closeAllConnections?.();
      preview.close();
    }

    server.close(async () => {
      try {
        stopCleanupScheduler();
      } catch (error) {
        log.error('failed to stop cleanup scheduler', error);
      }
      try {
        stopBackupScheduler();
      } catch (error) {
        log.error('failed to stop backup scheduler', error);
      }
      try {
        stopTaskScheduler();
      } catch (error) {
        log.error('failed to stop task scheduler', error);
      }
      // After the timers, before the database closes. The schedulers are
      // stopped first so nothing new starts during teardown; the MCP servers
      // are child processes and reaping them is the one step here that waits
      // on something outside this process, so it must finish before the
      // database handle goes away. `stopMcpSupervisor` is internally bounded
      // well under the force-exit budget above.
      try {
        await stopMcpSupervisor();
      } catch (error) {
        log.error('failed to stop the MCP supervisor', error);
      }
      try {
        reconcileOrphanedRuns();
      } catch (error) {
        log.error('failed to reconcile runs during shutdown', error);
      }
      try {
        closeDb();
      } catch (error) {
        log.error('failed to close database', error);
      }
      clearTimeout(forceExit);
      log.info('shutdown complete');
      process.exit(0);
    });

    server.closeIdleConnections?.();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Neither handler exits. A background bug — a scheduled task, a worktree
  // cleanup — should not take the whole process down and with it every
  // in-flight Code task's lane slot and SSE connection. PM2's restart-on-crash
  // stays the true last resort rather than the first thing a stray rejection
  // reaches. Both persist to error_log so the failure is still diagnosable
  // after the fact: stderr alone is lost to log rotation and invisible to the
  // debug console, which is the only place the user would ever look.
  process.on('unhandledRejection', (reason: unknown) => {
    log.error('unhandled rejection', reason);
    recordProcessError('unhandled rejection', reason);
  });
  process.on('uncaughtException', (error: unknown) => {
    log.error('uncaught exception', error);
    recordProcessError('uncaught exception', error);
  });
}

/**
 * Persist a process-level failure to `error_log`.
 *
 * Wrapped in its own try/catch and deliberately silent on failure: this runs
 * from a handler that exists to stop the process dying, so a throw here — the
 * database closed mid-shutdown, the disk full — would defeat the entire point.
 * `log.error` has already put the original on stderr before this is called, so
 * nothing is lost when the write cannot happen.
 */
function recordProcessError(kind: string, cause: unknown): void {
  try {
    const error = cause instanceof Error ? cause : undefined;
    logError({
      timestamp: Date.now(),
      severity: 'error',
      endpoint: `process:${kind}`,
      error_code: 'internal_error',
      error_message: error?.message ?? String(cause),
      ...(error?.stack !== undefined ? { stack_trace: error.stack } : {}),
    });
  } catch {
    // Already on stderr via log.error; there is nowhere better to put this.
  }
}

function main(): void {
  try {
    bootstrap();
  } catch (error) {
    log.error('bootstrap failed', error);
    process.exit(1);
  }

  registerProductionModules();
  const server = startServer();
  // Started synchronously and before the shutdown handlers, so a signal in the
  // first milliseconds of boot cannot leave a second listener orphaned. It
  // never throws: a port already in use leaves previews switched off with a
  // reason recorded, and the API keeps serving (see `http/previewServer.ts`).
  const preview = startPreviewServer();
  installShutdownHandlers(server, preview.server);

  // Background jobs start last, once the process is otherwise up. All three are
  // unref'd interval timers with staggered boot delays, so none of them can
  // hold shutdown open or collide on the job lock during startup. Scheduled
  // tasks fire whether or not a browser tab is open — PM2 keeps this process
  // alive, and that is the whole point of running them here rather than in the
  // frontend.
  startCleanupScheduler();
  startBackupScheduler();
  startTaskScheduler();

  // Last, and deliberately not awaited. Registration is synchronous, so
  // /api/mcp/status reports `managed: true` immediately; the spawning behind
  // it can take tens of seconds on a cold npx cache and no request should
  // wait for it. Until Slice 1 this was never called at all, which is why
  // every install reported no supervisor and every agent saw zero tools.
  startMcpSupervisor();
}

main();
