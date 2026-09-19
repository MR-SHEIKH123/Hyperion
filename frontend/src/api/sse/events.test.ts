import { describe,expect,it } from 'vitest';
import { decodeAgentEvent,decodeChatEvent } from './events';
describe('SSE event decoders',()=>{
 it('keeps Chat named events separate from agent channels',()=>{expect(decodeChatEvent({event:'token',data:'{"text":"hello"}'})).toMatchObject({ok:true,event:{type:'token',data:{text:'hello'}}});expect(decodeAgentEvent({event:'agent',data:'{"channel":"partial","tool":"code","chatId":"c","text":"x"}'})).toMatchObject({ok:true,event:{type:'agent',data:{channel:'partial'}}});});
 it('isolates malformed JSON instead of terminating parsing',()=>{expect(decodeChatEvent({event:'token',data:'{"text":'})).toEqual({ok:false,reason:'malformed_json',eventName:'token'});});
 it('reports unknown events without treating them as valid additions',()=>{expect(decodeChatEvent({event:'future',data:'{}'})).toEqual({ok:false,reason:'unknown_event',eventName:'future'});});
});
