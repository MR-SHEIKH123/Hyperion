import type{TaskViewEvent}from'./task-events';import{fromBackendRun,type ActiveMetadata,type TaskViewState}from'./task-state';
export type InvalidTransitionReporter=(state:TaskViewState,event:TaskViewEvent)=>void;
const reportDefault:InvalidTransitionReporter=(state,event)=>{if(import.meta.env.DEV)console.warn('Ignored invalid task-state transition',{from:state.kind,event:event.type});};
const withCancel=(state:Exclude<TaskViewState,{kind:'idle'}>,pendingCancel:boolean):TaskViewState=>({...state,pendingCancel});
export function reduceTaskState(state:TaskViewState,event:TaskViewEvent,report:InvalidTransitionReporter=reportDefault):TaskViewState{
 switch(event.type){
  case'reset':return{kind:'idle'};
  case'connect':if(state.kind==='idle')return{kind:'connecting',taskId:event.taskId,tool:event.tool,pendingCancel:false};break;
  case'backend_state':{
   if(state.kind==='idle'){report(state,event);return state;}
   if(state.taskId!==event.run.taskId||state.tool!==event.run.tool){report(state,event);return state;}
   return fromBackendRun(event.run,state.pendingCancel);
  }
  case'connection_lost':{
   if(state.kind==='connecting'||state.kind==='running'||state.kind==='paused'||state.kind==='approval_required'||state.kind==='ready_for_review'){
    const common:ActiveMetadata={taskId:state.taskId,tool:state.tool,pendingCancel:state.pendingCancel};
    return{kind:'reconnecting',...common,previous:state};
   }break;
  }
  case'cancel_requested':if(state.kind!=='idle'&&state.kind!=='complete'&&state.kind!=='error'&&state.kind!=='stopped')return withCancel(state,true);break;
  case'cancel_settled':if(state.kind!=='idle')return withCancel(state,false);break;
 }
 report(state,event);return state;
}
