import type { FrontendContract } from '../manifest';

export interface DiscoveredRoute{method:string;path:string;}
export interface CompatibilityReport{
  compatible:boolean;
  supported:number;
  knownGaps:number;
  regressions:{id:string;method:string;path:string;reason:string}[];
  undocumented:DiscoveredRoute[];
}
const key=(method:string,path:string)=>`${method.toUpperCase()} ${path}`;
const concrete=(path:string)=>!path.includes('{tool}');

export function compareContracts(contracts:readonly FrontendContract[],routes:readonly DiscoveredRoute[]):CompatibilityReport{
  const actual=new Set(routes.map(route=>key(route.method,route.path)));
  const expectedConcrete=new Set(contracts.filter(c=>c.status==='implemented'&&concrete(c.expectedPath)).map(c=>key(c.method,c.expectedPath)));
  const regressions=contracts.filter(c=>(c.status==='implemented'||c.status==='route-mismatch')&&concrete(c.expectedPath)&&!actual.has(key(c.method,c.expectedPath))).map(c=>({id:c.id,method:c.method,path:c.expectedPath,reason:'A previously supported contract is absent.'}));
  const undocumented=routes.filter(route=>!expectedConcrete.has(key(route.method,route.path))&&!contracts.some(c=>concrete(c.expectedPath)&&key(c.method,c.expectedPath)===key(route.method,route.path)));
  const supported=contracts.filter(c=>c.status==='implemented'||c.status==='route-mismatch').length;
  return {compatible:regressions.length===0,supported,knownGaps:contracts.length-supported,regressions,undocumented};
}
