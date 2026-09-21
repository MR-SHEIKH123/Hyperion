import { describe,expect,it } from 'vitest';
import { taskStateResponseSchema } from './tasks';
const run=(state:string)=>({run:{runId:'r',taskId:'t',tool:'code',state,pauseReason:null,errorCode:null,errorMessage:null,startedAt:1,updatedAt:2,completedAt:null}});
describe('task state wire contract',()=>{
 it('accepts the backend TaskRun states',()=>{expect(taskStateResponseSchema.safeParse(run('ready_for_review')).success).toBe(true);});
 // It flipped when it was supposed to: the backend writes this state since
 // migration 020 (boot reconciliation), so refusing it would now turn a valid
 // response into `invalid_response`.
 it('accepts interrupted now that the backend returns it',()=>{expect(taskStateResponseSchema.safeParse(run('interrupted')).success).toBe(true);});
 it('still refuses a state the backend does not send',()=>{expect(taskStateResponseSchema.safeParse(run('cancelled')).success).toBe(false);});
 it('rejects invented lifecycle states',()=>{expect(taskStateResponseSchema.safeParse(run('cancelling')).success).toBe(false);});
});
