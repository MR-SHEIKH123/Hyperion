import { z } from 'zod';

/**
 * Provenance wire contracts (docs/API.md §12.3a, Prompt 1.39 A6).
 *
 * Two fields, and the schemas keep them exactly that narrow: a version's parent,
 * and the knowledge sources a run used. Anything wider would be provenance the
 * backend does not promise.
 */

export const artifactVersionSchema = z
  .object({
    id: z.string(),
    artifactKey: z.string(),
    tool: z.string(),
    version: z.number().int().positive(),
    label: z.string().nullable(),
    /** True when the version is stored inline; false means it is a file reference. */
    inline: z.boolean(),
    bytes: z.number().int().nonnegative().nullable(),
    sha256: z.string().nullable(),
    createdAt: z.number(),
    /**
     * The version this one replaced, derived by the backend.
     *
     * `null` means version 1 — where the artifact started — and never "unknown":
     * a schema that allowed `undefined` here would let a missing derivation read
     * as a beginning.
     */
    parentVersion: z.number().int().positive().nullable(),
  })
  .passthrough();

export const artifactVersionsResponseSchema = z
  .object({
    artifactKey: z.string(),
    versions: z.array(artifactVersionSchema),
  })
  .passthrough();

export const runKnowledgeSourceSchema = z
  .object({
    sourceId: z.string(),
    label: z.string().nullable(),
    filename: z.string(),
    bytes: z.number().int().nonnegative().nullable(),
    sha256: z.string().nullable(),
    usedAt: z.number(),
  })
  .passthrough();

export const runKnowledgeResponseSchema = z
  .object({
    run: z
      .object({
        runId: z.string(),
        taskId: z.string(),
        state: z.string(),
        startedAt: z.number(),
        updatedAt: z.number(),
      })
      .passthrough(),
    /** The sources used as evidence. Empty is a real answer, not a failed read. */
    knowledgeSources: z.array(runKnowledgeSourceSchema),
  })
  .passthrough();

export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
export type RunKnowledgeSource = z.infer<typeof runKnowledgeSourceSchema>;
