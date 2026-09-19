import{describe,expect,it}from'vitest';import{compareContracts}from'./compare';
const contracts=[{id:'stable',method:'GET',expectedPath:'/api/stable',status:'implemented' as const},{id:'known-gap',method:'GET',expectedPath:'/api/missing',status:'missing' as const}];
describe('compatibility comparison',()=>{
 it('fails only when previously supported contracts regress',()=>{expect(compareContracts(contracts,[])).toMatchObject({compatible:false,regressions:[{id:'stable'}]});});
 it('keeps known gaps visible without making the report incompatible',()=>{const report=compareContracts(contracts,[{method:'GET',path:'/api/stable'}]);expect(report.compatible).toBe(true);expect(report.knownGaps).toBe(1);});
 it('reports undocumented routes',()=>{const report=compareContracts(contracts,[{method:'GET',path:'/api/stable'},{method:'POST',path:'/api/new'}]);expect(report.undocumented).toEqual([{method:'POST',path:'/api/new'}]);});
});
