import type { z } from 'zod';
import type { taskStateResponseSchema } from '../../contracts/wire/tasks';

export type BackendRun=z.infer<typeof taskStateResponseSchema>['run'];
export interface ActiveMetadata{taskId:string;tool:'code'|'cowork'|'design';pendingCancel:boolean;}
export type TaskViewState=
 |{kind:'idle'}
 |({kind:'connecting'}&ActiveMetadata)
 |({kind:'running';runId:string;startedAt:number}&ActiveMetadata)
 |({kind:'paused';runId:string;reason:string|null;since:number}&ActiveMetadata)
 |({kind:'approval_required';runId:string;reason:string|null}&ActiveMetadata)
 |({kind:'ready_for_review';runId:string}&ActiveMetadata)
 |({kind:'reconnecting';previous:Exclude<TaskViewState,{kind:'idle'}|{kind:'reconnecting'}>}&ActiveMetadata)
 |({kind:'stopped';runId:string;reason:string|null}&ActiveMetadata)
 |({kind:'interrupted';runId:string;reason:string|null}&ActiveMetadata)
 |({kind:'complete';runId:string;completedAt:number}&ActiveMetadata)
 |({kind:'error';runId:string;code:string|null;message:string|null}&ActiveMetadata);

export interface ApprovalDialogState{open:boolean;approvalId:string|null;}
export const idleTaskState=():TaskViewState=>({kind:'idle'});
const meta=(run:BackendRun,pendingCancel=false):ActiveMetadata=>({taskId:run.taskId,tool:run.tool,pendingCancel});
export function fromBackendRun(run:BackendRun,pendingCancel=false):TaskViewState{
 const common=meta(run,pendingCancel);
 switch(run.state){
  case'running':return{kind:'running',...common,runId:run.runId,startedAt:run.startedAt};
  case'paused':return{kind:'paused',...common,runId:run.runId,reason:run.pauseReason,since:run.updatedAt};
  case'blocked':return{kind:'approval_required',...common,runId:run.runId,reason:run.pauseReason};
  case'ready_for_review':return{kind:'ready_for_review',...common,runId:run.runId};
  case'stopped':return{kind:'stopped',...common,runId:run.runId,reason:run.pauseReason};
  case'interrupted':return{kind:'interrupted',...common,runId:run.runId,reason:run.errorMessage??run.pauseReason};
  case'complete':return{kind:'complete',...common,runId:run.runId,completedAt:run.completedAt??run.updatedAt};
  case'error':return{kind:'error',...common,runId:run.runId,code:run.errorCode,message:run.errorMessage};
 }
}
