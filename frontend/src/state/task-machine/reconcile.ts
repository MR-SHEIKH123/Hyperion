import{ApiError}from'../../api/errors';import type{BackendRun,TaskViewState}from'./task-state';import{fromBackendRun}from'./task-state';
export interface RememberedTaskHint{taskId:string;tool:'code'|'cowork'|'design';projectId?:string;}
export type ReconciledTask={availability:'available';hint:RememberedTaskHint;state:TaskViewState}|{availability:'missing';hint:RememberedTaskHint}|{availability:'degraded';hint:RememberedTaskHint;error:unknown};
export type TaskStateFetcher=(tool:RememberedTaskHint['tool'],taskId:string,signal?:AbortSignal)=>Promise<{run:BackendRun}>;
export async function reconcileTaskHints(hints:readonly RememberedTaskHint[],fetchState:TaskStateFetcher,signal?:AbortSignal):Promise<ReconciledTask[]>{
 return Promise.all(hints.map(async hint=>{try{const response=await fetchState(hint.tool,hint.taskId,signal);return{availability:'available',hint,state:fromBackendRun(response.run)} as const;}catch(error){if(error instanceof ApiError&&error.code==='not_found')return{availability:'missing',hint}as const;return{availability:'degraded',hint,error}as const;}}));
}
