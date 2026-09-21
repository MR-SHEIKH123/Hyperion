import { describe,expect,it } from 'vitest';
import { activeProviderResponseSchema, providerSchema } from './providers';
const provider={id:'p1',name:'Local',type:'local',baseUrl:'http://localhost:11434',hasKey:false,apiKeyHint:null,enabled:true,priority:1,healthStatus:'healthy',lastError:null,lastErrorAt:null,lastSuccessAt:1,modelCount:1,modelsFetchedAt:1,modelsError:null,createdAt:1,updatedAt:1};
const active={provider,egress:'local',redactionCheckEnabled:true,zdr:{status:'local_no_egress',requirement:'prefer'}};
describe('provider wire contract',()=>{
 it('accepts additive backend fields but never requires a credential',()=>{expect(providerSchema.parse({...provider,futureField:true})).toMatchObject({id:'p1'});expect(providerSchema.keyof().options).not.toContain('apiKey');});
 it('rejects an unknown provider type so capability drift is visible',()=>{expect(providerSchema.safeParse({...provider,type:'puter'}).success).toBe(false);});
 it('refuses an egress class or retention status the point-of-send line cannot label',()=>{
  expect(activeProviderResponseSchema.safeParse(active).success).toBe(true);
  expect(activeProviderResponseSchema.safeParse({...active,egress:'maybe'}).success).toBe(false);
  expect(activeProviderResponseSchema.safeParse({...active,zdr:{...active.zdr,status:'zdr_probably'}}).success).toBe(false);
  expect(activeProviderResponseSchema.safeParse({...active,zdr:{...active.zdr,requirement:'strict'}}).success).toBe(false);
 });
 it('requires the retention story the route always sends, rather than reading a missing one as absent',()=>{
  const withoutZdr={provider:active.provider,egress:active.egress,redactionCheckEnabled:active.redactionCheckEnabled};
  expect(activeProviderResponseSchema.safeParse(withoutZdr).success).toBe(false);
  expect(activeProviderResponseSchema.safeParse({...active,zdr:{...active.zdr,status:null}}).success).toBe(true);
 });
});
