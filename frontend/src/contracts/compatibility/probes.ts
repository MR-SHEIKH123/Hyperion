import type { CapabilityRegistry } from '../capabilities/registry';
export interface CapabilityProbe{capabilityId:string;run(signal:AbortSignal):Promise<void>;}
export async function runCapabilityProbes(registry:CapabilityRegistry,probes:readonly CapabilityProbe[],signal:AbortSignal):Promise<void>{
  await Promise.all(probes.map(async probe=>{try{await probe.run(signal);registry.applyProbe(probe.capabilityId,{ok:true});}catch(error){if(signal.aborted)throw error;registry.markRequestError(probe.capabilityId,error instanceof Error?error.message:'Probe failed.');}}));
}
