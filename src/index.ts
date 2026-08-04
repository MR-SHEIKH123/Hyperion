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
import { runMigrations } from './db/migrate.ts';
import { reconcileOrphanedRuns } from './orchestrator/runState.ts';
import { seedDefaultServers } from './services/mcp/defaults.ts';
import { ensureSkillDirs } from './services/skills/intake.ts';
import { startCleanupScheduler, stopCleanupScheduler } from './services/storage/cleanup.ts';
import { createApp } from './http/app.ts';
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

  const orphaned = reconcileOrphanedRuns();
  if (orphaned > 0) {
    log.warn('reconciled orphaned runs from a previous process', { count: orphaned });
  }

  ensureSkillDirs();

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
function installShutdownHandlers(server: Server): void {
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

    server.close(() => {
      try {
        stopCleanupScheduler();
      } catch (error) {
        log.error('failed to stop cleanup scheduler', error);
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
  process.on('unhandledRejection', (reason: unknown) => {
    log.error('unhandled rejection', reason);
  });
  process.on('uncaughtException', (error: unknown) => {
    log.error('uncaught exception', error);
  });
}

function main(): void {
  try {
    bootstrap();
  } catch (error) {
    log.error('bootstrap failed', error);
    process.exit(1);
  }

  const server = startServer();
  installShutdownHandlers(server);
  startCleanupScheduler();
}

main();
