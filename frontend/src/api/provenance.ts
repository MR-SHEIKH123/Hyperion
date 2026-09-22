import {
  artifactVersionsResponseSchema,
  runKnowledgeResponseSchema,
} from '../contracts/wire/provenance';
import { request } from './client';

/**
 * Provenance reads (Prompt 1.39 A6).
 *
 * Both are queries, not commands: a version timeline and a run's evidence are
 * facts about work already done, so there is nothing here that mutates anything —
 * which is also why neither takes a body and both accept an abort signal.
 */

/** The version timeline of one artifact, newest first. */
export const getArtifactVersions = (artifactKey: string, signal?: AbortSignal) =>
  request(
    `/api/artifacts/versions?key=${encodeURIComponent(artifactKey)}`,
    artifactVersionsResponseSchema,
    { ...(signal === undefined ? {} : { signal }) },
  );

/** What a Cowork run used as evidence. */
export const getRunProvenance = (taskId: string, signal?: AbortSignal) =>
  request(`/api/cowork/tasks/${encodeURIComponent(taskId)}/provenance`, runKnowledgeResponseSchema, {
    ...(signal === undefined ? {} : { signal }),
  });
