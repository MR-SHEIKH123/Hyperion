import { z } from 'zod';

export const toolIdSchema=z.enum(['chat','code','cowork','design','playground','plugins','skills','settings']);
export const attachmentHintSchema=z.object({id:z.string(),name:z.string(),type:z.string().optional(),size:z.number().int().nonnegative().optional()}).strict();
export const safeDraftSchema=z.object({text:z.string(),attachments:z.array(attachmentHintSchema).default([]),updatedAt:z.number()}).strict();
export const panelLayoutSchema=z.object({sizes:z.record(z.string(),z.number().nonnegative()),collapsed:z.array(z.string())}).strict();
export const projectPresentationSchema=z.object({
  lastTool:toolIdSchema.optional(),openViewIds:z.record(z.string(),z.array(z.string())).default({}),
  selectedViewIds:z.record(z.string(),z.string()).default({}),selectedModelIds:z.record(z.string(),z.string()).default({}),
  panelLayouts:z.record(z.string(),panelLayoutSchema).default({}),lastViewedVersions:z.record(z.string(),z.number().int().positive()).default({}),
}).strict();
export const scrollAnchorSchema=z.object({anchorId:z.string(),offset:z.number().finite()}).strict();
export const navigationHintSchema=z.object({kind:z.enum(['task','chat','artifact']),id:z.string(),tool:toolIdSchema.optional(),projectId:z.string().optional()}).strict();
export const onboardingDraftSchema=z.object({path:z.enum(['fresh','restore']).nullable(),currentStepId:z.string().nullable(),selectedProviderType:z.string().optional(),selectedModelId:z.string().optional(),spendingCapDraft:z.number().nonnegative().optional(),projectName:z.string().optional(),projectMode:z.enum(['fresh','existing']).optional(),backupDestinationType:z.string().optional()}).strict();
export const persistedStateV1Schema=z.object({
  version:z.literal(1),projects:z.record(z.string(),projectPresentationSchema),drafts:z.record(z.string(),safeDraftSchema),navigationHints:z.array(navigationHintSchema),
  // Where the reader was in a scrolling surface, keyed by view (`chat:12`). A field
  // added under `version: 1` on purpose: it defaults, so state written before it
  // existed still parses instead of being thrown away as corrupt.
  scrollAnchors:z.record(z.string(),scrollAnchorSchema).default({}),
  onboarding:onboardingDraftSchema.optional(),
}).strict();
export type PersistedStateV1=z.infer<typeof persistedStateV1Schema>;
export type ScrollAnchor=z.infer<typeof scrollAnchorSchema>;
export const emptyPersistedState=():PersistedStateV1=>({version:1,projects:{},drafts:{},navigationHints:[],scrollAnchors:{}});
