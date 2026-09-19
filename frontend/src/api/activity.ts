import { activityPageSchema } from '../contracts/wire/activity';
import { request } from './client';
export function getActivity(input:{before?:number;limit?:number}={},signal?:AbortSignal){const q=new URLSearchParams();if(input.before!==undefined)q.set('before',String(input.before));if(input.limit!==undefined)q.set('limit',String(input.limit));return request(`/api/activity${q.size?`?${q}`:''}`,activityPageSchema,{...(signal===undefined?{}:{signal})});}
