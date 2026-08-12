/**
 * Skills endpoints.
 *
 * Intake is deliberately two-phase. An upload or URL fetch only *stages* the
 * files and returns a preview containing the risk scan and the disclaimer; the
 * skill isn't installed until the user confirms. That's what lets the UI show
 * "this skill runs shell commands, are you sure?" before anything lands in the
 * skills directory.
 *
 * The scan is advisory, never a verdict — see `riskscan.ts`. We surface it and
 * require an explicit acknowledgement for risky content, but we don't pretend
 * to be a sandbox.
 */

import { Router } from 'express';
import multer from 'multer';

import { env } from '../config/env.ts';
import {
  confirmIntake,
  discardStaging,
  stageUpload,
  stageUrl,
} from '../services/skills/intake.ts';
import type { StagedFile } from '../services/skills/intake.ts';
import {
  deleteSkill,
  listSkills,
  requireSkill,
  skillsPromptBlock,
  skillsSummary,
  toPublic,
  updateSkill,
} from '../services/skills/registry.ts';
import { canInstallBinary, installBinary, provisionSkill } from '../services/skills/provision.ts';

import { DISCLAIMER } from '../services/skills/riskscan.ts';

import { AppError } from '../util/errors.ts';
import { wrap } from './errors.ts';
import { asBool, asOptionalString, asString, body, pathParam, queryBool } from './params.ts';

export const skillsRouter: Router = Router();

/**
 * Memory storage keeps this simple: skills are small text bundles, and the
 * intake stager wants buffers anyway. The size cap is the same one the rest of
 * the app uses; multer's LIMIT_FILE_SIZE is translated to a 413 by the error
 * handler.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes, files: 200 },
});

/**
 * Turns multer's files into stager input. `originalname` carries the relative
 * path when a folder was uploaded, so we keep it as `relativePath` to preserve
 * the directory shape a SKILL.md may reference.
 */
function toStagedFiles(files: Express.Multer.File[] | undefined): StagedFile[] {
  if (!files || files.length === 0) {
    throw new AppError('bad_request', 'No files were uploaded.');
  }
  return files.map((file) => {
    const name = file.originalname || 'unnamed';
    return {
      name: name.split('/').pop() || name,
      buffer: file.buffer,
      relativePath: name,
    };
  });
}

// --- read ------------------------------------------------------------------

skillsRouter.get(
  '/',
  wrap(async (_req, res) => {
    res.json({ skills: listSkills().map(toPublic), disclaimer: DISCLAIMER });
  }),
);

/**
 * The compact name+description list the agents inject into their context. Kept
 * separate from `GET /` so a prompt build never pays for the full records.
 */
skillsRouter.get(
  '/summary',
  wrap(async (req, res) => {
    if (queryBool(req, 'prompt')) {
      res.json({ prompt: skillsPromptBlock() });
      return;
    }
    res.json({ skills: skillsSummary() });
  }),
);

// --- intake ----------------------------------------------------------------

/** Stages an uploaded skill (single file or a whole folder) and previews it. */
skillsRouter.post(
  '/upload',
  upload.array('files'),
  wrap(async (req, res) => {
    const files = toStagedFiles(req.files as Express.Multer.File[] | undefined);
    const sourceRef = asOptionalString(body(req).sourceRef, 'sourceRef') ?? null;
    const preview = await stageUpload(files, { sourceRef });
    res.status(201).json({ preview });
  }),
);

/** Stages a skill fetched from a URL (a zip or a raw SKILL.md). */
skillsRouter.post(
  '/fetch',
  wrap(async (req, res) => {
    const preview = await stageUrl(asString(body(req).url, 'url'));
    res.status(201).json({ preview });
  }),
);

/**
 * Installs a staged skill. `acknowledgeRisk` is required when the scan flagged
 * something; `confirmIntake` enforces that, we just pass it through.
 *
 * This is also where dependency installation happens, so the request takes as
 * long as a `pip install` does. A 201 means *registered*, not necessarily
 * runnable — the outcome is in `skill.dependencies`, and a client should read
 * `dependencies.runnable` rather than assume success.
 */
skillsRouter.post(
  '/confirm',
  wrap(async (req, res) => {
    const payload = body(req);
    const skill = await confirmIntake({
      stagingId: asString(payload.stagingId, 'stagingId'),
      name: asOptionalString(payload.name, 'name'),
      description: asOptionalString(payload.description, 'description'),
      token: asOptionalString(payload.token, 'token'),
      enabled: asBool(payload.enabled, 'enabled'),
      acknowledgeRisk: asBool(payload.acknowledgeRisk, 'acknowledgeRisk'),
      skipProvisioning: asBool(payload.skipProvisioning, 'skipProvisioning'),
    });
    res.status(201).json({ skill: toPublic(skill) });
  }),
);


/** Throws away a staging directory the user decided against. */
skillsRouter.delete(
  '/staging/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    discardStaging(id);
    res.json({ discarded: true, id });
  }),
);

// --- per-skill -------------------------------------------------------------

/**
 * Retries dependency installation for an already-registered skill.
 *
 * The usual reason to call this is a failure the user has since fixed — a
 * missing compiler, a Python that wasn't on PATH, a network that was down.
 * Without it, the only way to retry an install would be deleting the skill and
 * uploading it again.
 *
 * Registered before `/:id` so Express doesn't match "provision" as an id.
 */
skillsRouter.post(
  '/:id/provision',
  wrap(async (req, res) => {
    const skill = requireSkill(pathParam(req, 'id'));
    const updated = await provisionSkill(skill, { force: true });
    res.json({ skill: toPublic(updated) });
  }),
);

/**
 * Installs one system binary a skill is waiting on — the `needs-user-approval`
 * exit.
 *
 * `confirm: true` is mandatory and deliberately not defaulted. Everything else in
 * the skills system stays inside Hyperion's own directories; this installs
 * software for the whole computer, so the decision has to arrive from a person.
 * Without the flag the service refuses and says why.
 *
 * A refusal is a **200**, not a 4xx. "ffmpeg is not on the curated list" and
 * "winget is not available here" are answers about the machine, not mistakes in
 * the request, and the client renders the message either way. Only a malformed
 * request (no `name`) is a 400. Read `installed` for the outcome and the returned
 * skill for the new status.
 *
 * Registered before `/:id` so Express doesn't match "binaries" as an id.
 */
skillsRouter.post(
  '/:id/binaries',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    const payload = body(req);
    const name = asString(payload.name, 'name');
    const confirmed = asBool(payload.confirm, 'confirm') ?? false;

    const result = await installBinary(id, name, { confirmed });
    res.json({
      installed: result.installed,
      message: result.message,
      // So a UI can tell "we could install this for you, just confirm" apart from
      // "you have to do this yourself" without a second endpoint.
      installable: canInstallBinary(name),
      skill: toPublic(result.skill),
    });
  }),
);

skillsRouter.get(
  '/:id',

  wrap(async (req, res) => {
    res.json({ skill: toPublic(requireSkill(pathParam(req, 'id'))) });
  }),
);


const patchHandler = wrap(async (req, res) => {
  const id = pathParam(req, 'id');
  requireSkill(id);
  const payload = body(req);
  const skill = updateSkill(id, {
    name: asOptionalString(payload.name, 'name'),
    description: asOptionalString(payload.description, 'description'),
    token: asOptionalString(payload.token, 'token'),
    enabled: asBool(payload.enabled, 'enabled'),
  });
  res.json({ skill: toPublic(skill) });
});

skillsRouter.patch('/:id', patchHandler);
skillsRouter.put('/:id', patchHandler);

/**
 * Deletes a skill. `?keepFiles=1` unregisters it but leaves the directory on
 * disk, which is handy when the user wants to edit it by hand and re-import.
 */
skillsRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    requireSkill(id);
    deleteSkill(id, { keepFiles: queryBool(req, 'keepFiles') ?? false });
    res.json({ deleted: true, id });
  }),
);
