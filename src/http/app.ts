/**
 * Express application assembly.
 * Localhost-only, single-user: there is deliberately no authentication layer.
 * Remote access is expected to go through Tailscale, and `src/index.ts` warns
 * loudly if the server binds to a non-loopback address.
 */
import express from 'express';

import { activityRouter } from './activity.ts';
import { agentsRouter } from './agents.ts';
import { continuationRouter } from './continuation.ts';
import { artifactsRouter } from './artifacts.ts';
import { backupRouter } from './backup.ts';
import { chatRouter } from './chat.ts';
import { coworkRouter } from './cowork.ts';
import { designRouter } from './design.ts';
import { errorHandler, notFoundHandler } from './errors.ts';
import { errorLogRouter } from './errorLog.ts';
import { exportsRouter } from './exports.ts';

import { healthRouter } from './health.ts';

import { mcpRouter } from './mcp.ts';
import { memoryRouter } from './memory.ts';
import { projectsRouter } from './projects.ts';
import { providersRouter } from './providers.ts';
import { pushRouter } from './push.ts';

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

  app.use('/api/health', healthRouter);
  app.use('/api/activity', activityRouter);

  app.use('/api/providers', providersRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/mcp', mcpRouter);
  app.use('/api/skills', skillsRouter);
  app.use('/api/storage', storageRouter);
  app.use('/api/usage', usageRouter);
  app.use('/api/backup', backupRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/memory', memoryRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/resources', resourcesRouter);
  app.use('/api/artifacts', artifactsRouter);
  app.use('/api/export', exportsRouter);


  app.use('/api/push', pushRouter);
  app.use('/api/errors', errorLogRouter);


  // Cowork's knowledge library and scheduled tasks. Mounted before the bare
  // `/api` agents router so its `/cowork/...` paths are matched here first;
  // the two do not overlap, but the specific mount deciding is the safer order.
  app.use('/api/cowork', coworkRouter);

  // Brand-approved assets, for the same reason: `agentsRouter` already owns
  // /design/run-task and /design/tasks/..., and while /design/assets/... does
  // not collide with either, letting the specific mount decide keeps a future
  // /design/:something in agents.ts from swallowing these.
  app.use('/api/design', designRouter);

  // Continuation and approvals, mounted before `agentsRouter` because they share
  // its `/{tool}/tasks/:taskId/...` shape and the specific mount should win. They
  // live in their own module rather than in agents.ts because the lifecycle they
  // implement — claim a park, apply a decision, resume — is a different thing from
  // starting a run, and merging them would put the mutex next to code that has no
  // reason to know about it.
  app.use('/api', continuationRouter);

  // Agent routes own their own sub-paths (/code/..., /cowork/..., /design/...).
  app.use('/api', agentsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
