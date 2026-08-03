/**
 * Express application assembly.
 * Localhost-only, single-user: there is deliberately no authentication layer.
 * Remote access is expected to go through Tailscale, and `src/index.ts` warns
 * loudly if the server binds to a non-loopback address.
 */
import express from 'express';

import { env } from '../config/env.ts';
import { agentsRouter } from './agents.ts';
import { backupRouter } from './backup.ts';
import { chatRouter } from './chat.ts';
import { errorHandler, notFoundHandler } from './errors.ts';
import { mcpRouter } from './mcp.ts';
import { memoryRouter } from './memory.ts';
import { providersRouter } from './providers.ts';
import { resourcesRouter } from './resources.ts';
import { settingsRouter } from './settings.ts';
import { skillsRouter } from './skills.ts';
import { storageRouter } from './storage.ts';
import { usageRouter } from './usage.ts';

import type { Express } from 'express';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);

  // Uploads are handled by multer inside the routers that need them; the JSON
  // limit only has to cover message payloads and settings blobs.
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      name: 'aistudio',
      uptimeSec: Math.round(process.uptime()),
      loopback: env.bindIsLoopback,
    });
  });

  app.use('/api/providers', providersRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/mcp', mcpRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/storage', storageRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/backup', backupRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/memory', memoryRouter);
  app.use('/api/resources', resourcesRouter);

  // Agent routes own their own sub-paths (/code/..., /cowork/..., /design/...).
  app.use('/api', agentsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
