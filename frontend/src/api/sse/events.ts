import { z } from 'zod';
import {
  chatSseDoneSchema,
  chatSseErrorSchema,
  chatSseOpenSchema,
  chatSsePausedSchema,
  chatSseResumedSchema,
  chatSseTokenSchema,
  chatSseUsageSchema,
} from '../../contracts/wire/chat';
import type { ParsedSseEvent } from './parser';

/**
 * Chat stream payloads (docs/API.md §4.3). Note the `error` event carries the
 * run's error shape, NOT the HTTP error envelope — the envelope is what
 * pre-stream JSON failures look like; once the stream is open, errors are
 * events on a 200.
 */
const chatSchemas = {
  open: chatSseOpenSchema,
  token: chatSseTokenSchema,
  paused: chatSsePausedSchema,
  resumed: chatSseResumedSchema,
  usage: chatSseUsageSchema,
  done: chatSseDoneSchema,
  error: chatSseErrorSchema,
} as const;
export type ChatSseEvent = { [K in keyof typeof chatSchemas]: { type: K; data: z.infer<(typeof chatSchemas)[K]> } }[keyof typeof chatSchemas];

const agentChannels = z.enum(['started','partial','artifact','provider','switched','approval_required','task_parked','ceiling_reached','context_compacted','subagent_started','subagent_finished','stopped','result']);
const agentEnvelope = z.object({ channel:agentChannels, tool:z.enum(['code','cowork','design']), chatId:z.string() }).passthrough();
export type AgentSseEvent = { type:'agent'; data:z.infer<typeof agentEnvelope> } | { type:'error'; data:z.infer<typeof chatSseErrorSchema> };

export type DecodeResult<T> = { ok:true; event:T } | { ok:false; reason:'unknown_event'|'malformed_json'|'invalid_payload'; eventName:string; issues?:unknown };
function json(event:ParsedSseEvent):{ok:true;value:unknown}|{ok:false}{try{return {ok:true,value:JSON.parse(event.data) as unknown};}catch{return {ok:false};}}

export function decodeChatEvent(frame:ParsedSseEvent):DecodeResult<ChatSseEvent>{
  const schema=chatSchemas[frame.event as keyof typeof chatSchemas];
  if(schema===undefined)return {ok:false,reason:'unknown_event',eventName:frame.event};
  const parsedJson=json(frame);if(!parsedJson.ok)return {ok:false,reason:'malformed_json',eventName:frame.event};
  const parsed=schema.safeParse(parsedJson.value);if(!parsed.success)return {ok:false,reason:'invalid_payload',eventName:frame.event,issues:parsed.error.issues};
  return {ok:true,event:{type:frame.event,data:parsed.data} as ChatSseEvent};
}

/**
 * The `error` frame is the **run's** error shape, not the HTTP envelope — on this
 * route and on the chat stream alike, because both are written by the same
 * emitter, `sendError` (src/orchestrator/sse.ts), which puts `{runId, code,
 * message, retryable}` on the wire. The envelope is what a *pre-stream* refusal
 * looks like: once the status line is sent there is no envelope to send, which is
 * why `api/errors.ts` is the only caller that parses one (docs/API.md §1.23 tells
 * the same story from the server's side, and was confirmed by HTTP smoke testing).
 *
 * Decoding this frame with the envelope schema rejected every real one. Nothing
 * noticed for the same reason `wire/projects.ts` went unnoticed: a hand-built
 * fixture agreed with the decoder, so both halves of the frontend were consistent
 * with each other and wrong about the wire. The cost here was larger, because
 * `error` is the only terminal event name this protocol has — a rejected frame
 * meant a failed run fell through to reconciliation with no code and no message,
 * which is exactly what the red line in the run log is for.
 */
export function decodeAgentEvent(frame:ParsedSseEvent):DecodeResult<AgentSseEvent>{
  if(frame.event!=='agent'&&frame.event!=='error')return {ok:false,reason:'unknown_event',eventName:frame.event};
  const parsedJson=json(frame);if(!parsedJson.ok)return {ok:false,reason:'malformed_json',eventName:frame.event};
  const schema=frame.event==='agent'?agentEnvelope:chatSseErrorSchema;
  const parsed=schema.safeParse(parsedJson.value);if(!parsed.success)return {ok:false,reason:'invalid_payload',eventName:frame.event,issues:parsed.error.issues};
  return {ok:true,event:{type:frame.event,data:parsed.data} as AgentSseEvent};
}
