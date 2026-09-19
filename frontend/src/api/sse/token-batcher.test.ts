import { afterEach,describe,expect,it,vi } from 'vitest';
import { createTokenBatcher } from './token-batcher';
afterEach(()=>vi.unstubAllGlobals());
describe('token batcher',()=>{
 it('combines token fragments but flushes synchronously for state events',()=>{let callback:(time:number)=>void=()=>{};vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{callback=cb;return 1;});vi.stubGlobal('cancelAnimationFrame',vi.fn());const delivered:string[]=[];const batch=createTokenBatcher((text)=>delivered.push(text));batch.add('Hel');batch.add('lo');expect(delivered).toEqual([]);callback(0);expect(delivered).toEqual(['Hello']);batch.add('!');batch.flush();expect(delivered).toEqual(['Hello','!']);});
});
