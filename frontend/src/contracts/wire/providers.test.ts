import { describe,expect,it } from 'vitest';
import { activeProviderResponseSchema, providerSchema, providerTypeSchema } from './providers';
const provider={id:'p1',name:'Local',type:'local',baseUrl:'http://localhost:11434',hasKey:false,apiKeyHint:null,enabled:true,priority:1,healthStatus:'healthy',lastError:null,lastErrorAt:null,lastSuccessAt:1,modelCount:1,modelsFetchedAt:1,modelsError:null,createdAt:1,updatedAt:1};
const active={provider,egress:'local',egressProxy:null,redactionCheckEnabled:true,zdr:{status:'local_no_egress',requirement:'prefer'}};
describe('provider wire contract',()=>{
 it('accepts additive backend fields but never requires a credential',()=>{expect(providerSchema.parse({...provider,futureField:true})).toMatchObject({id:'p1'});expect(providerSchema.keyof().options).not.toContain('apiKey');});
 it('rejects an unknown provider type so capability drift is visible',()=>{expect(providerSchema.safeParse({...provider,type:'someday'}).success).toBe(false);});
// 1.38: `puter` is a real type now, but asserting that it parses is not enough —
// the drift this test exists for is a *new* server-side type arriving unread, and
// the way to keep catching it is to point the assertion at a word no build has.
it('accepts puter, whose credential is a token rather than a vendor key',()=>{expect(providerTypeSchema.parse('puter')).toBe('puter');});
 it('refuses an egress class or retention status the point-of-send line cannot label',()=>{
  expect(activeProviderResponseSchema.safeParse(active).success).toBe(true);
  expect(activeProviderResponseSchema.safeParse({...active,egress:'maybe'}).success).toBe(false);
  expect(activeProviderResponseSchema.safeParse({...active,zdr:{...active.zdr,status:'zdr_probably'}}).success).toBe(false);
  expect(activeProviderResponseSchema.safeParse({...active,zdr:{...active.zdr,requirement:'strict'}}).success).toBe(false);
 });
 it('requires the retention story the route always sends, rather than reading a missing one as absent',()=>{
  const withoutZdr={provider:active.provider,egress:active.egress,egressProxy:active.egressProxy,redactionCheckEnabled:active.redactionCheckEnabled};
  expect(activeProviderResponseSchema.safeParse(withoutZdr).success).toBe(false);
  expect(activeProviderResponseSchema.safeParse({...active,zdr:{...active.zdr,status:null}}).success).toBe(true);
 });
 it('requires the proxy disclosure to be stated, null included, so an omission is not read as a direct route',()=>{
  // The same argument the retention story gets: the route always sends this, and
  // a schema that let it be absent would render "no proxy" for a payload that
  // simply does not say — which is the direction that understates where bytes go.
  const {egressProxy,...withoutProxy}=active;
  // The fixture is the un-proxied case, and naming that keeps the destructure
  // honest: the value is what the test is *about*, not a discardable sibling.
  expect(egressProxy).toBeNull();
  expect(activeProviderResponseSchema.safeParse(withoutProxy).success).toBe(false);
  expect(activeProviderResponseSchema.safeParse({...active,egressProxy:null}).success).toBe(true);
  expect(activeProviderResponseSchema.safeParse({...active,egressProxy:{redacted:'http://p:3128',authority:'p:3128',scheme:'http',hasCredentials:false,offMachine:true}}).success).toBe(true);
  // A scheme the transport cannot dial must not reach the UI as a fact.
  expect(activeProviderResponseSchema.safeParse({...active,egressProxy:{redacted:'socks5://p:1080',authority:'p:1080',scheme:'socks5',hasCredentials:false,offMachine:true}}).success).toBe(false);
 });
});
