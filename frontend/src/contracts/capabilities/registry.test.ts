import {describe,expect,it}from'vitest';
import {CapabilityRegistry}from'./registry';
const contracts=[{id:'present',method:'GET',expectedPath:'/api/x',status:'implemented' as const},{id:'partial',method:'GET',expectedPath:'/api/y',status:'partial' as const},{id:'absent',method:'GET',expectedPath:'/api/z',status:'missing' as const}];
describe('capability registry',()=>{
 it('derives availability from checked contracts',()=>{const r=new CapabilityRegistry(contracts);expect(r.get('present')).toMatchObject({availability:'available',condition:'healthy'});expect(r.get('partial')).toMatchObject({availability:'partial'});expect(r.get('absent')).toMatchObject({availability:'unavailable'});});
 it('never reinterprets a request failure as unsupported',()=>{const r=new CapabilityRegistry(contracts);r.markRequestError('present','Backend unreachable');expect(r.get('present')).toMatchObject({availability:'available',condition:'degraded',source:'runtime-probe',reason:'Backend unreachable'});});
});
