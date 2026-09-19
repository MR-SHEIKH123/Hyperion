export interface TokenBatcher { add(text:string):void; flush():void; dispose():void; }
export function createTokenBatcher(deliver:(text:string)=>void):TokenBatcher{
  let pending='';let handle:number|null=null;
  const schedule=()=>{if(handle!==null)return;handle=requestAnimationFrame(()=>{handle=null;flush();});};
  const flush=()=>{if(pending==='')return;const value=pending;pending='';deliver(value);};
  return {add(text){pending+=text;schedule();},flush(){if(handle!==null){cancelAnimationFrame(handle);handle=null;}flush();},dispose(){if(handle!==null)cancelAnimationFrame(handle);handle=null;pending='';}};
}
