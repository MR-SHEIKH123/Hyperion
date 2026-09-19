import { z } from 'zod';
import backendSnapshot from '../../contracts/backend-routes.json';
import frontendSnapshot from '../../contracts/frontend-contracts.json';

export const contractStatusSchema=z.enum(['implemented','partial','route-mismatch','missing','intentionally-unsupported']);
const routeSchema=z.object({method:z.string(),path:z.string(),source:z.string(),exposure:z.enum(['frontend','deferred-frontend','backend-only']),capability:z.string()});
const frontendContractSchema=z.object({id:z.string(),method:z.string(),expectedPath:z.string(),status:contractStatusSchema,milestone:z.string().optional(),reason:z.string().optional(),specifiedPath:z.string().optional()});
const backendManifestSchema=z.object({schemaVersion:z.number().int().positive(),generatedFrom:z.string(),routes:z.array(routeSchema)});
const frontendManifestSchema=z.object({schemaVersion:z.number().int().positive(),statuses:z.array(contractStatusSchema),contracts:z.array(frontendContractSchema)});
export const backendManifest=backendManifestSchema.parse(backendSnapshot);
export const frontendManifest=frontendManifestSchema.parse(frontendSnapshot);
export type FrontendContract=z.infer<typeof frontendContractSchema>;
