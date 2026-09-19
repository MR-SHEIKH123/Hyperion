import { z } from 'zod';
import { errorEnvelopeSchema } from '../../contracts/wire/common';
import type { ParsedSseEvent } from './parser';

const token = z.object({ text: z.string() }).passthrough();
const usage = z.object({ tokensIn:z.number().optional(), tokensOut:z.number().optional() }).passthrough();
const open = z.object({ chatId:z.string().optional(), runId:z.string().optional() }).passthrough();
const paused = z.object({ reason:z.string().optional(), message:z.string().optional() }).passthrough();
const resumed = z.object({}).passthrough();
const done = z.object({}).passthrough();

const chatSchemas = { open, token, paused, resumed, usage, done, error:errorEnvelopeSchema } as const;
export type ChatSseEvent = { [K in keyof typeof chatSchemas]: { type:K; data:z.infer<(typeof chatSchemas)[K]> } }[keyof typeof chatSchemas];

const agentChannels = z.enum(['started','partial','artifact','provider','switched','approval_required','task_parked','ceiling_reached','context_compacted','subagent_started','subagent_finished','stopped','result']);
const agentEnvelope = z.object({ channel:agentChannels, tool:z.enum(['code','cowork','design']), chatId:z.string() }).passthrough();
export type AgentSseEvent = { type:'agent'; data:z.infer<typeof agentEnvelope> } | { type:'error'; data:z.infer<typeof errorEnvelopeSchema> };

export type DecodeResult<T> = { ok:true; event:T } | { ok:false; reason:'unknown_event'|'malformed_json'|'invalid_payload'; eventName:string; issues?:unknown };
function json(event:ParsedSseEvent):{ok:true;value:unknown}|{ok:false}{try{return {ok:true,value:JSON.parse(event.data) as unknown};}catch{return {ok:false};}}

export function decodeChatEvent(frame:ParsedSseEvent):DecodeResult<ChatSseEvent>{
  const schema=chatSchemas[frame.event as keyof typeof chatSchemas];
  if(schema===undefined)return {ok:false,reason:'unknown_event',eventName:frame.event};
  const parsedJson=json(frame);if(!parsedJson.ok)return {ok:false,reason:'malformed_json',eventName:frame.event};
  const parsed=schema.safeParse(parsedJson.value);if(!parsed.success)return {ok:false,reason:'invalid_payload',eventName:frame.event,issues:parsed.error.issues};
  return {ok:true,event:{type:frame.event,data:parsed.data} as ChatSseEvent};
}

export function decodeAgentEvent(frame:ParsedSseEvent):DecodeResult<AgentSseEvent>{
  if(frame.event!=='agent'&&frame.event!=='error')return {ok:false,reason:'unknown_event',eventName:frame.event};
  const parsedJson=json(frame);if(!parsedJson.ok)return {ok:false,reason:'malformed_json',eventName:frame.event};
  const schema=frame.event==='agent'?agentEnvelope:errorEnvelopeSchema;
  const parsed=schema.safeParse(parsedJson.value);if(!parsed.success)return {ok:false,reason:'invalid_payload',eventName:frame.event,issues:parsed.error.issues};
  return {ok:true,event:{type:frame.event,data:parsed.data} as AgentSseEvent};
}
