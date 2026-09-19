import type{BackendRun}from'./task-state';
export type TaskViewEvent=
 |{type:'connect';taskId:string;tool:'code'|'cowork'|'design'}
 |{type:'backend_state';run:BackendRun}
 |{type:'connection_lost'}
 |{type:'cancel_requested'}
 |{type:'cancel_settled'}
 |{type:'reset'};
