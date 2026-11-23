'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobHandoff } from '../server/job-handoff.mjs';
import { createJobHandoffHttpHandler } from '../server/job-handoff-http.mjs';

function psd() {
  const bytes = new Uint8Array(30);
  bytes.set([0x38,0x42,0x50,0x53,0,1]);
  return bytes;
}
function setup() {
  const jobs = new Map(), sources = new Map();
  const store = {
    async createJob(job, bytes) { jobs.set(job.projectId, structuredClone(job)); sources.set(job.projectId,new Uint8Array(bytes)); },
    async getJob(id) { return jobs.has(id) ? structuredClone(jobs.get(id)) : null; },
    async getSource(id) { return sources.has(id) ? new Uint8Array(sources.get(id)) : null; },
    async claimJob(id, revision, lease) { const job=jobs.get(id); if(!job||job.revision!==revision||job.status!=='queued')return {claimed:false};job.status='running';job.revision++;job.lease=lease;return {claimed:true,job:structuredClone(job)}; },
    async completeJob(id, revision, agentId, result) { const job=jobs.get(id);if(!job||job.revision!==revision||job.lease?.agentId!==agentId)return {updated:false};job.status='awaiting-review';job.revision++;job.result=result;return {updated:true,job:structuredClone(job)}; }
  };
  const handoff=createJobHandoff({store,secret:'sa-http-test-secret-with-more-than-thirty-two-characters',
    resolveSession:async token=>token==='site-token'?{subject:'site-user'}:null,
    authorizeAgent:async({agentId})=>agentId==='sa-renderer'});
  return {handler:createJobHandoffHttpHandler({jobHandoff:handoff}),handoff};
}
test('HTTP handoff accepts private PSD multipart upload and returns opaque project identity', async()=>{
  const {handler}=setup(),form=new FormData();
  form.set('file',new Blob([psd()],{type:'image/vnd.adobe.photoshop'}),'hero.psd');
  form.set('intent','Split character anatomy');
  const response=await handler(new Request('https://sa.example/api/jobs',{method:'POST',
    headers:{authorization:'Bearer site-token'},body:form}));
  assert.equal(response.status,201);
  const body=await response.json();
  assert.match(body.projectId,/^sa_/);
  assert.equal(body.status,'queued');
  assert.ok(body.token);
});
test('HTTP handoff protects job metadata and source bytes with scoped bearer tokens', async()=>{
  const {handler}=setup(),form=new FormData();
  form.set('file',new Blob([psd()]),'hero.psd');
  const created=await (await handler(new Request('https://sa.example/api/jobs',{method:'POST',
    headers:{authorization:'Bearer site-token'},body:form}))).json();
  const metadata=await handler(new Request('https://sa.example/api/jobs/'+created.projectId,
    {headers:{authorization:'Bearer '+created.token}}));
  assert.equal(metadata.status,200);
  const source=await handler(new Request('https://sa.example/api/jobs/'+created.projectId+'/source',
    {headers:{authorization:'Bearer '+created.token}}));
  assert.equal(source.status,200);
  assert.deepEqual(new Uint8Array(await source.arrayBuffer()),psd());
  const forbidden=await handler(new Request('https://sa.example/api/jobs/'+created.projectId+'/source',
    {headers:{authorization:'Bearer site-token'}}));
  assert.equal(forbidden.status,401);
});
test('HTTP handoff rejects missing session and unsupported upload methods', async()=>{
  const {handler}=setup(),form=new FormData();
  form.set('file',new Blob([psd()]),'hero.psd');
  const denied=await handler(new Request('https://sa.example/api/jobs',{method:'POST',body:form}));
  assert.equal(denied.status,401);
  const wrongMethod=await handler(new Request('https://sa.example/api/jobs',{method:'PUT'}));
  assert.equal(wrongMethod.status,405);
});
