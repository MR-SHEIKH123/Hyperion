import { ApiError, networkError, responseError } from '../errors';
import { parseSseStream, type ParsedSseEvent } from './parser';

export type StreamEnd = 'terminal-event'|'socket-closed'|'cancelled'|'disconnected';
export interface StreamSessionOptions {
  request: RequestInfo | URL;
  init?: RequestInit;
  terminalEvents: ReadonlySet<string>;
  onFrame(frame:ParsedSseEvent):void;
  onMalformed?(frame:ParsedSseEvent,error:unknown):void;
  onEnd(reason:StreamEnd):void;
  reconcile(signal:AbortSignal):Promise<void>;
  signal?:AbortSignal;
}

/** Opens exactly one mutation stream. A disconnect reconciles state and never replays the request. */
export async function runStreamSession(options:StreamSessionOptions):Promise<void>{
  const controller=new AbortController();
  const abort=()=>controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort',abort,{once:true});
  let terminal=false;
  const seenEventIds=new Set<string>();
  try{
    let response:Response;
    try{response=await fetch(options.request,{...options.init,signal:controller.signal});}catch{
      if(controller.signal.aborted){options.onEnd('cancelled');return;}
      await options.reconcile(controller.signal);
      options.onEnd('disconnected');return;
    }
    if(!response.ok)throw await responseError(response);
    if(!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream'))throw new ApiError('Hyperion returned a non-streaming response.','invalid_response',response.status,false);
    if(response.body===null)throw new ApiError('Hyperion returned an empty stream.','invalid_response',response.status,false);
    for await(const frame of parseSseStream(response.body,controller.signal)){
      // SSE ids are the protocol's replay identity. Token text itself must never
      // be content-deduplicated: repeated words are valid model output.
      if(frame.id!==undefined){
        if(seenEventIds.has(frame.id))continue;
        seenEventIds.add(frame.id);
      }
      options.onFrame(frame);
      if(options.terminalEvents.has(frame.event)){terminal=true;break;}
    }
    if(controller.signal.aborted){options.onEnd('cancelled');return;}
    if(terminal){options.onEnd('terminal-event');return;}
    await options.reconcile(controller.signal);
    options.onEnd('socket-closed');
  }catch(error){
    if(controller.signal.aborted){options.onEnd('cancelled');return;}
    if(error instanceof ApiError)throw error;
    throw networkError(error);
  }finally{options.signal?.removeEventListener('abort',abort);controller.abort();}
}
