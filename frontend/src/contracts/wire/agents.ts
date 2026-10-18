import { z } from 'zod';

/**
 * Wire contracts for agent profiles, the default profile, profile
 * import, and the read-only permission layers (Settings 2.5, slice 4).
 *
 * Read against `src/http/settings.ts` (`publicProfile`,
 * `/settings/agent-profiles`, `/settings/agents`), `src/http/agents.ts`
 * (`/code/agents/import`, `/code/permissions`, `/code/rules`,
 * `/code/agents`, `/code/commands`), `src/services/code/profileImport.ts`,
 * `src/services/code/projectContext.ts`, and `src/types/core.ts` on
 * 2026-10-18. `publicProfile` omits the profile body on purpose — it can
 * run to hundreds of lines and nothing in a listing renders it — so no
 * schema here has a `body` field either.
 */

export const agentModeSchema = z.enum(['ask', 'plan', 'act']);
export type AgentModeWire = z.infer<typeof agentModeSchema>;

export const permissionActionSchema = z.enum(['allow', 'ask', 'deny']);
export type PermissionActionWire = z.infer<typeof permissionActionSchema>;

/** A scalar covers every invocation; a map is glob → action. */
export const permissionRuleSchema = z.union([
  permissionActionSchema,
  z.record(z.string(), permissionActionSchema),
]);
export type PermissionRuleWire = z.infer<typeof permissionRuleSchema>;

export const publicProfileSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  /** Null for a built-in, which has no file. */
  path: z.string().nullable(),
  builtin: z.boolean(),
  mode: agentModeSchema,
  visibility: z.enum(['primary', 'subagent', 'all']),
  /** Listing-only: a hidden profile still resolves by name. */
  hidden: z.boolean(),
  variant: z.enum(['low', 'medium', 'high']).nullable(),
  model: z.string().nullable(),
  /** Null means "every tool the agent registers". */
  tools: z.array(z.string()).nullable(),
  permissions: z.record(z.string(), permissionRuleSchema).nullable(),
});
export type PublicProfileWire = z.infer<typeof publicProfileSchema>;

export const agentProfilesResponseSchema = z.object({
  count: z.number(),
  defaultProfile: z.string().nullable(),
  profiles: z.array(publicProfileSchema),
});

export const agentsSettingsResponseSchema = z.object({
  defaultAgentProfile: z.string().nullable(),
  /** What each mode actually resolves to — Ask and Plan outrank the stored default. */
  resolvedFor: z.object({
    ask: z.string(),
    plan: z.string(),
    act: z.string(),
  }),
  builtin: z.array(publicProfileSchema),
});

export const agentsSettingsPutResponseSchema = z.object({
  defaultAgentProfile: z.string().nullable(),
});

export const profileImportResultSchema = z.object({
  filename: z.string(),
  name: z.string().nullable(),
  status: z.enum(['imported', 'overwritten', 'renamed', 'skipped', 'invalid']),
  path: z.string().optional(),
  error: z.string().optional(),
});
export type ProfileImportResultWire = z.infer<typeof profileImportResultSchema>;

export const profileImportResponseSchema = z.object({
  project: z.object({ id: z.string(), name: z.string() }),
  imported: z.number(),
  results: z.array(profileImportResultSchema),
  count: z.number(),
});
export type ProfileImportWire = z.infer<typeof profileImportResponseSchema>;

export const permissionLayerNameSchema = z.enum(['builtin', 'profile', 'project', 'session', 'inherited']);

export const permissionsResponseSchema = z.object({
  project: z.string(),
  mode: agentModeSchema,
  profile: z.object({
    name: z.string(),
    builtin: z.boolean(),
    mode: agentModeSchema,
  }),
  /** Evaluation order: reading top to bottom is how the engine reaches its verdict. */
  layers: z.array(
    z.object({
      layer: permissionLayerNameSchema,
      rules: z.record(z.string(), permissionRuleSchema),
    }),
  ),
});
export type PermissionsWire = z.infer<typeof permissionsResponseSchema>;

export const projectRuleSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  scope: z.string().nullable(),
  matched: z.boolean(),
});

export const rulesResponseSchema = z.object({
  source: z.enum(['hyperion', 'hyperion-md', 'none']),
  scopeEnforced: z.boolean(),
  count: z.number(),
  matchedCount: z.number(),
  rules: z.array(projectRuleSchema),
});

export const projectAgentSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  tools: z.array(z.string()).nullable(),
  model: z.string().nullable(),
});

export const projectAgentsResponseSchema = z.object({
  count: z.number(),
  agents: z.array(projectAgentSchema),
});

export const projectCommandSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
});

export const projectCommandsResponseSchema = z.object({
  count: z.number(),
  commands: z.array(projectCommandSchema),
});
