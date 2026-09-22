import { describe,expect,it } from 'vitest';
import { decodeAgentEvent,decodeChatEvent } from './events';
describe('SSE event decoders',()=>{
 it('keeps Chat named events separate from agent channels',()=>{expect(decodeChatEvent({event:'token',data:'{"text":"hello"}'})).toMatchObject({ok:true,event:{type:'token',data:{text:'hello'}}});expect(decodeAgentEvent({event:'agent',data:'{"channel":"partial","tool":"code","chatId":"c","text":"x"}'})).toMatchObject({ok:true,event:{type:'agent',data:{channel:'partial'}}});});
 it('isolates malformed JSON instead of terminating parsing',()=>{expect(decodeChatEvent({event:'token',data:'{"text":'})).toEqual({ok:false,reason:'malformed_json',eventName:'token'});});
 it('reports unknown events without treating them as valid additions',()=>{expect(decodeChatEvent({event:'future',data:'{}'})).toEqual({ok:false,reason:'unknown_event',eventName:'future'});});
 it('decodes the run error frame the server actually sends, on both protocols',()=>{
  // One emitter writes both: `sendError` in src/orchestrator/sse.ts, which puts the
  // run's error on the wire as `{runId, code, message, retryable}` (docs/API.md §1.23,
  // confirmed there by HTTP smoke testing). This decoded as `invalid_payload` until
  // the agent decoder stopped expecting the HTTP envelope — and because `error` is the
  // only terminal event name the agent protocol has, every failed run was falling
  // through to reconciliation with no code and no message.
  const frame={event:'error',data:'{"runId":null,"code":"no_healthy_provider","message":"no provider could be reached","retryable":false}'};
  expect(decodeChatEvent(frame)).toMatchObject({ok:true,event:{type:'error',data:{code:'no_healthy_provider',message:'no provider could be reached',retryable:false}}});
  expect(decodeAgentEvent(frame)).toMatchObject({ok:true,event:{type:'error',data:{code:'no_healthy_provider',retryable:false}}});
 });
 it('does not accept the HTTP envelope as a stream frame',()=>{
  // The envelope answers a *pre-stream* refusal. By the time an error frame is sent the
  // status line is long gone, so no envelope can arrive on a stream — accepting one here
  // would have hidden the mismatch above rather than fixed it.
  const envelope={event:'error',data:'{"error":{"code":"no_healthy_provider","message":"x","retryable":false}}'};
  expect(decodeAgentEvent(envelope)).toMatchObject({ok:false,reason:'invalid_payload',eventName:'error'});
  expect(decodeChatEvent(envelope)).toMatchObject({ok:false,reason:'invalid_payload',eventName:'error'});
 });
});
