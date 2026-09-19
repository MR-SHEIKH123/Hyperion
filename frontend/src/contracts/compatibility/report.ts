import { backendManifest,frontendManifest } from '../manifest';
import { compareContracts,type CompatibilityReport } from './compare';

export interface DeveloperContractReport extends CompatibilityReport{
  generatedAt:string;
  backendRouteCount:number;
  statuses:Record<string,number>;
  gaps:{id:string;status:string;reason:string|null}[];
}
export function createDeveloperContractReport(now:Date=new Date()):DeveloperContractReport{
  const report=compareContracts(frontendManifest.contracts,backendManifest.routes);
  const statuses:Record<string,number>={};
  for(const contract of frontendManifest.contracts)statuses[contract.status]=(statuses[contract.status]??0)+1;
  return {...report,generatedAt:now.toISOString(),backendRouteCount:backendManifest.routes.length,statuses,gaps:frontendManifest.contracts.filter(c=>c.status!=='implemented').map(c=>({id:c.id,status:c.status,reason:c.reason??null}))};
}
