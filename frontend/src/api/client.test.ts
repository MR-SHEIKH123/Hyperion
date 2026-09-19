import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from './client';
import { ApiError } from './errors';

afterEach(()=>vi.unstubAllGlobals());

describe('API client',()=>{
  it('validates successful responses at the wire boundary',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({value:'ok'}),{status:200,headers:{'Content-Type':'application/json'}})));
    await expect(request('/api/example',z.object({value:z.string()}))).resolves.toEqual({value:'ok'});
  });
  it('turns schema drift into a compatibility error',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({value:42}),{status:200})));
    await expect(request('/api/example',z.object({value:z.string()}))).rejects.toMatchObject({code:'invalid_response'});
  });
  it('normalizes coded backend errors',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'busy',message:'At capacity',retryable:true,details:{limit:2}}}),{status:409})));
    await expect(request('/api/example',z.object({}))).rejects.toMatchObject({code:'busy',status:409,retryable:true,details:{limit:2}});
  });
  it('refuses absolute and non-API paths before fetch',async()=>{
    await expect(request('https://example.com',z.unknown())).rejects.toThrow(/relative/);
  });
  it('normalizes network failures without leaking their message',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('secret transport detail')));
    try{await request('/api/example',z.unknown());expect.fail('expected rejection');}catch(error){expect(error).toBeInstanceOf(ApiError);expect(error).toMatchObject({code:'network_error',message:'Hyperion could not be reached.'});}
  });
});
