/**
 * Cowork's own storage endpoints: knowledge sources and scheduled tasks.
 *
 * These are separate from `/api/cowork/run-task` (in `agents.ts`) because they
 * are plain CRUD against the database and need no registered agent module. A
 * user can file reference documents and set up a nightly task on a backend
 * where no agent loop has attached yet.
 *
 * Knowledge sources are the standing reference library. They are deliberately
 * *not* gallery assets: no `last_accessed_at`, no pin flag, and their own
 * filesystem scope, so the 3-month asset sweep in `storage/cleanup.ts` has
 * nothing to select them by. Only an explicit DELETE removes one.
 *
 * Running a scheduled task on demand is intentionally exposed
 * (`POST /:id/run`): the scheduler and this route call the same
 * `runScheduledTask`, so "test my task now" exercises the real path rather
 * than a preview of it.
 */

import { Router } from 'express';
import multer from 'multer';

import { env } from '../config/env.ts';
import {
  deleteKnowledgeSource,
  knowledgeExists,
  knowledgePath,
  listKnowledgeSources,
  requireKnowledgeSource,
  saveKnowledgeSource,
  toPublic as knowledgeToPublic,
} from '../services/cowork/knowledge.ts';
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  listTaskRuns,
  requireScheduledTask,
  updateScheduledTask,
} from '../services/cowork/scheduledTasks.ts';
import { runScheduledTask } from '../services/cowork/scheduler.ts';
import { AppError } from '../util/errors.ts';
import { wrap } from './errors.ts';
import {
  asBool,
  asNullableString,
  asOptionalString,
  asString,
  body,
  pathParam,
  queryNumber,
} from './params.ts';

export const coworkRouter: Router = Router();

/**
 * One file per request, in memory. Knowledge sources are documents the user
 * picked by hand, not bulk imports, and `saveKnowledgeSource` wants a buffer.
 * multer's LIMIT_FILE_SIZE is already translated to a 413 by the error handler.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes, files: 1 },
});

// --- knowledge sources -----------------------------------------------------

coworkRouter.get(
  '/knowledge',
  wrap(async (_req, res) => {
    const sources = listKnowledgeSources();
    res.json({ count: sources.length, sources });
  }),
);

/**
 * Files a document into the library.
 *
 * The label is the user's own handle for the document and is separate from the
 * filename on purpose — `Q3-final-FINAL-v2.pdf` is what they uploaded, "Q3
 * board pack" is what they will look for later.
 */
coworkRouter.post(
  '/knowledge',
  upload.single('file'),
  wrap(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw new AppError('bad_request', 'No file was uploaded.', {
        details: { field: 'file' },
      });
    }
    const label = asOptionalString(body(req).label, 'label');
    const source = saveKnowledgeSource({
      filename: file.originalname || 'document',
      buffer: file.buffer,
      ...(label === undefined ? {} : { label }),
      ...(file.mimetype ? { mimeType: file.mimetype } : {}),
    });
    res.status(201).json({ source: knowledgeToPublic(source) });
  }),
);

coworkRouter.get(
  '/knowledge/:id',
  wrap(async (req, res) => {
    res.json({ source: knowledgeToPublic(requireKnowledgeSource(pathParam(req, 'id'))) });
  }),
);

/**
 * Streams the document bytes. As with gallery assets, a row can outlive its
 * file, and that is a `not_found` about the file rather than a 500 about us.
 *
 * Reading a knowledge source records nothing: there is no access timestamp to
 * update, because nothing ever expires one.
 */
coworkRouter.get(
  '/knowledge/:id/file',
  wrap(async (req, res, next) => {
    const id = pathParam(req, 'id');
    const source = requireKnowledgeSource(id);
    if (!knowledgeExists(source)) {
      throw new AppError('not_found', `Knowledge file is missing on disk: ${source.filename}`, {
        details: { id, relPath: source.relPath },
      });
    }
    res.sendFile(knowledgePath(source), (error) => {
      if (error) next(error);
    });
  }),
);

coworkRouter.delete(
  '/knowledge/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    // requireKnowledgeSource inside deleteKnowledgeSource has already thrown
    // not_found if the row was absent, so reaching the response means the row
    // existed and is now gone. bytesFreed can legitimately be 0.
    const bytesFreed = deleteKnowledgeSource(id);
    res.json({ deleted: true, id, bytesFreed });
  }),
);

// --- scheduled tasks -------------------------------------------------------

coworkRouter.get(
  '/scheduled-tasks',
  wrap(async (_req, res) => {
    const tasks = listScheduledTasks();
    res.json({ count: tasks.length, tasks });
  }),
);

/**
 * Creates a task. `schedule` is validated by `parseSchedule`, which accepts
 * `daily:HH:MM` and `weekly:D:HH:MM` and rejects anything else as a
 * `bad_request` naming the field — v1 has no cron expressions.
 */
coworkRouter.post(
  '/scheduled-tasks',
  wrap(async (req, res) => {
    const payload = body(req);
    const chatId = asNullableString(payload.chatId, 'chatId');
    const cwd = asNullableString(payload.cwd, 'cwd');
    const enabled = asBool(payload.enabled, 'enabled');
    const task = createScheduledTask({
      name: asString(payload.name, 'name'),
      prompt: asString(payload.prompt, 'prompt'),
      schedule: asString(payload.schedule, 'schedule'),
      modelId: asString(payload.modelId, 'modelId'),
      ...(chatId === undefined ? {} : { chatId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(enabled === undefined ? {} : { enabled }),
    });
    res.status(201).json({ task });
  }),
);

coworkRouter.get(
  '/scheduled-tasks/:id',
  wrap(async (req, res) => {
    res.json({ task: requireScheduledTask(pathParam(req, 'id')) });
  }),
);

/**
 * Partial update. Every field is optional and an omitted one is left alone, so
 * the enable/disable toggle in the UI is a one-key PUT rather than a read,
 * merge and write.
 */
function updateTaskHandler(): ReturnType<typeof wrap> {
  return wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    const payload = body(req);
    const name = asOptionalString(payload.name, 'name');
    const prompt = asOptionalString(payload.prompt, 'prompt');
    const schedule = asOptionalString(payload.schedule, 'schedule');
    const modelId = asOptionalString(payload.modelId, 'modelId');
    const chatId = asNullableString(payload.chatId, 'chatId');
    const cwd = asNullableString(payload.cwd, 'cwd');
    const enabled = asBool(payload.enabled, 'enabled');
    const task = updateScheduledTask(id, {
      ...(name === undefined ? {} : { name }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(schedule === undefined ? {} : { schedule }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(chatId === undefined ? {} : { chatId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(enabled === undefined ? {} : { enabled }),
    });
    res.json({ task });
  });
}

coworkRouter.put('/scheduled-tasks/:id', updateTaskHandler());
coworkRouter.patch('/scheduled-tasks/:id', updateTaskHandler());

coworkRouter.delete(
  '/scheduled-tasks/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    deleteScheduledTask(id);
    res.json({ deleted: true, id });
  }),
);

coworkRouter.get(
  '/scheduled-tasks/:id/history',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireScheduledTask(id);
    const runs = listTaskRuns(id, queryNumber(req, 'limit') ?? 50);
    res.json({ taskId: id, count: runs.length, runs });
  }),
);

/**
 * Fires a task immediately, out of schedule.
 *
 * `runScheduledTask` never throws — a failure is recorded on the run row — so
 * this returns 202 and the caller reads the outcome from `/history`. It also
 * takes the job lock in queue mode, meaning "run now" can legitimately sit and
 * wait behind whatever is already running rather than being refused.
 */
coworkRouter.post(
  '/scheduled-tasks/:id/run',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireScheduledTask(id);
    void runScheduledTask(id);
    res.status(202).json({ started: true, id });
  }),
);
