import { describe,expect,it } from 'vitest';
import { providerSchema } from './providers';
const provider={id:'p1',name:'Local',type:'local',baseUrl:'http://localhost:11434',hasKey:false,apiKeyHint:null,enabled:true,priority:1,healthStatus:'healthy',lastError:null,lastErrorAt:null,lastSuccessAt:1,modelCount:1,modelsFetchedAt:1,modelsError:null,createdAt:1,updatedAt:1};
describe('provider wire contract',()=>{
 it('accepts additive backend fields but never requires a credential',()=>{expect(providerSchema.parse({...provider,futureField:true})).toMatchObject({id:'p1'});expect(providerSchema.keyof().options).not.toContain('apiKey');});
 it('rejects an unknown provider type so capability drift is visible',()=>{expect(providerSchema.safeParse({...provider,type:'puter'}).success).toBe(false);});
});
