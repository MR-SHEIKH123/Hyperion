import { describe,expect,it } from 'vitest';
import { taskStateResponseSchema } from './tasks';
const run=(state:string)=>({run:{runId:'r',taskId:'t',tool:'code',state,pauseReason:null,errorCode:null,errorMessage:null,startedAt:1,updatedAt:2,completedAt:null}});
describe('task state wire contract',()=>{
 it('accepts the backend TaskRun states',()=>{expect(taskStateResponseSchema.safeParse(run('ready_for_review')).success).toBe(true);});
 it('rejects interrupted until the backend contract actually returns it',()=>{expect(taskStateResponseSchema.safeParse(run('interrupted')).success).toBe(false);});
 it('rejects invented lifecycle states',()=>{expect(taskStateResponseSchema.safeParse(run('cancelling')).success).toBe(false);});
});
