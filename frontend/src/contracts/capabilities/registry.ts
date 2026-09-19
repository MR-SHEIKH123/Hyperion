import { frontendManifest, type FrontendContract } from '../manifest';

export type CapabilityAvailability='available'|'partial'|'unavailable';
export type CapabilityCondition='healthy'|'degraded'|'error';
export interface RuntimeProbeResult{ok:boolean;reason?:string;}
export interface CapabilityState{
  id:string;
  availability:CapabilityAvailability;
  condition:CapabilityCondition;
  source:'contract'|'runtime-probe';
  reason?:string;
  contractStatus:FrontendContract['status'];
}

function contractAvailability(status:FrontendContract['status']):CapabilityAvailability{
  if(status==='implemented'||status==='route-mismatch')return 'available';
  if(status==='partial')return 'partial';
  return 'unavailable';
}

export class CapabilityRegistry{
  private readonly states:Map<string,CapabilityState>;
  constructor(contracts:readonly FrontendContract[]=frontendManifest.contracts){
    this.states=new Map(contracts.map(contract=>[contract.id,{
      id:contract.id,availability:contractAvailability(contract.status),condition:'healthy',source:'contract',
      ...(contract.reason===undefined?{}:{reason:contract.reason}),contractStatus:contract.status,
    }]));
  }
  get(id:string):CapabilityState|undefined{return this.states.get(id);}
  list():CapabilityState[]{return [...this.states.values()];}
  applyProbe(id:string,result:RuntimeProbeResult):CapabilityState{
    const current=this.states.get(id);if(current===undefined)throw new Error(`Unknown capability: ${id}`);
    // A failed request changes operational condition, never contractual support.
    const next:CapabilityState={...current,condition:result.ok?'healthy':'degraded',source:'runtime-probe',...(result.reason===undefined?{}:{reason:result.reason})};
    this.states.set(id,next);return next;
  }
  markRequestError(id:string,reason:string):CapabilityState{return this.applyProbe(id,{ok:false,reason});}
}
