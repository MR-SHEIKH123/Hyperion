import{describe,expect,it}from'vitest';import{ApiError}from'../../api/errors';import{reconcileTaskHints}from'./reconcile';import type{BackendRun}from'./task-state';
const running:BackendRun={runId:'r',taskId:'known',tool:'code',chatId:null,state:'running',pauseReason:null,errorCode:null,errorMessage:null,startedAt:1,updatedAt:1,completedAt:null};
describe('backend-authoritative task reconciliation',()=>{
 it('replaces a remembered id with backend lifecycle truth',async()=>{const result=await reconcileTaskHints([{taskId:'known',tool:'code'}],()=>Promise.resolve({run:running}));expect(result[0]).toMatchObject({availability:'available',state:{kind:'running'}});});
 it('marks a missing task unavailable instead of assuming completion',async()=>{const result=await reconcileTaskHints([{taskId:'gone',tool:'code'}],()=>Promise.reject(new ApiError('missing','not_found',404,false)));expect(result[0]).toMatchObject({availability:'missing',hint:{taskId:'gone'}});});
 it('keeps operational failures distinct from missing tasks',async()=>{const result=await reconcileTaskHints([{taskId:'known',tool:'code'}],()=>Promise.reject(new ApiError('offline','network_error',null,true)));expect(result[0]).toMatchObject({availability:'degraded'});});
});
