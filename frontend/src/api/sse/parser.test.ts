import { describe,expect,it } from 'vitest';
import { SseParser,parseSseStream } from './parser';

describe('SSE parser',()=>{
 it('survives chunk boundaries inside fields and JSON',()=>{const p=new SseParser();expect(p.push('eve')).toEqual([]);expect(p.push('nt: token\ndata: {"te')).toEqual([]);expect(p.push('xt":"Hi"}\n\n')).toEqual([{event:'token',data:'{"text":"Hi"}'}]);});
 it('joins multiline data and handles CRLF',()=>{const p=new SseParser();expect(p.push('event: note\r\ndata: first\r\ndata: second\r\n\r\n')).toEqual([{event:'note',data:'first\nsecond'}]);});
 it('ignores heartbeats and unknown fields',()=>{const p=new SseParser();expect(p.push(': ping\nunknown: x\n\n')).toEqual([]);});
 it('dispatches a final buffered event when the socket closes',()=>{const p=new SseParser();p.push('event: done\ndata: {}');expect(p.finish()).toEqual([{event:'done',data:'{}'}]);});
 it('parses UTF-8 split across byte chunks',async()=>{const bytes=new TextEncoder().encode('event: token\ndata: {"text":"✓"}\n\n');const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes.slice(0,bytes.length-3));c.enqueue(bytes.slice(bytes.length-3));c.close();}});const events=[];for await(const event of parseSseStream(stream))events.push(event);expect(events).toEqual([{event:'token',data:'{"text":"✓"}'}]);});
});
