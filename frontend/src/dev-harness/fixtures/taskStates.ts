import type{TaskViewState}from'../../state/task-machine/task-state';
const base={taskId:'fixture-task',tool:'code' as const,pendingCancel:false};
export const taskStateFixtures:Record<string,TaskViewState>={
 running:{kind:'running',...base,runId:'fixture-run',startedAt:Date.now()-12_000},
 paused:{kind:'paused',...base,runId:'fixture-run',reason:'The active provider is temporarily unavailable.',since:Date.now()-8_000},
 approval_required:{kind:'approval_required',...base,runId:'fixture-run',reason:'This action needs approval.'},
 ready_for_review:{kind:'ready_for_review',...base,runId:'fixture-run'},
 reconnecting:{kind:'reconnecting',...base,previous:{kind:'running',...base,runId:'fixture-run',startedAt:Date.now()-12_000}},
 stopped:{kind:'stopped',...base,runId:'fixture-run',reason:'The configured ceiling was reached.'},
 complete:{kind:'complete',...base,runId:'fixture-run',completedAt:Date.now()},
 error:{kind:'error',...base,runId:'fixture-run',code:'provider_error',message:'The provider could not complete the request.'},
};
