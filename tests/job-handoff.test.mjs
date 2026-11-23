'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobHandoff } from '../server/job-handoff.mjs';

const sha256 = async bytes => {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2,'0')).join('');
};
function psd() {
  const bytes = new Uint8Array(30);
  bytes.set([0x38,0x42,0x50,0x53,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
  return bytes;
}
function memoryStore() {
  const jobs = new Map(), sources = new Map();
  return {
    async createJob(job, bytes) {
      if (jobs.has(job.projectId)) throw Error('duplicate project');
      jobs.set(job.projectId, structuredClone(job)); sources.set(job.projectId, new Uint8Array(bytes));
    },
    async getJob(id) { return jobs.has(id) ? structuredClone(jobs.get(id)) : null; },
    async getSource(id) { const value = sources.get(id); return value ? new Uint8Array(value) : null; },
    async claimJob(id, revision, lease) {
      const job = jobs.get(id);
      if (!job || job.revision !== revision || job.status !== 'queued') return {claimed:false};
      job.status = 'running'; job.revision++; job.lease = lease; job.updatedAt = new Date().toISOString();
      return {claimed:true,job:structuredClone(job)};
    },
    async completeJob(id, revision, agentId, result) {
      const job = jobs.get(id);
      if (!job || job.revision !== revision || job.status !== 'running' || job.lease?.agentId !== agentId)
        return {updated:false};
      job.status = 'awaiting-review'; job.revision++; job.result = structuredClone(result);
      job.updatedAt = new Date().toISOString();
      return {updated:true,job:structuredClone(job)};
    },
    tamperSource(id) { sources.get(id)[0] ^= 0xff; }
  };
}
function setup() {
  const store = memoryStore();
  const handoff = createJobHandoff({
    store, secret: 'sa-job-handoff-test-secret-which-is-long-enough',
    resolveSession: async token => token === 'valid-site-session' ? {subject:'user.123'} : null,
    authorizeAgent: async ({agentId}) => agentId === 'gpt6-semantic-planner' || agentId === 'sa-renderer',
    now: () => Date.parse('2026-11-23T00:00:00Z')
  });
  return {store,handoff};
}

test('website creates a private source-bound PSD job and only receives a short-lived scoped token', async () => {
  const {handoff} = setup(), bytes = psd();
  const created = await handoff.create({sessionToken:'valid-site-session',fileName:'character.psd',bytes,intent:'Prepare an animation rig'});
  assert.match(created.projectId,/^sa_[A-Za-z0-9_-]{20,40}$/);
  assert.equal(created.status,'queued');
  assert.equal(created.sourceSha256,await sha256(bytes));
  assert.equal(created.bytes,bytes.length);
  const record = await handoff.read({token:created.token});
  assert.equal(record.status,'queued');
  assert.equal(record.ownerSubject,undefined);
  assert.equal(record.source.sha256,created.sourceSha256);
});

test('handoff rejects unverified website sessions and malformed PSD/PSB uploads', async () => {
  const {handoff} = setup();
  await assert.rejects(()=>handoff.create({sessionToken:'spoofed',fileName:'x.psd',bytes:psd()}),/verified site session/);
  const bad = psd(); bad[0]=0;
  await assert.rejects(()=>handoff.create({sessionToken:'valid-site-session',fileName:'x.psd',bytes:bad}),/signature is invalid/);
  await assert.rejects(()=>handoff.create({sessionToken:'valid-site-session',fileName:'x.exe',bytes:psd()}),/Only named PSD\/PSB/);
});

test('only authorized agents receive scoped tokens and can atomically claim a job once', async () => {
  const {handoff} = setup();
  const created = await handoff.create({sessionToken:'valid-site-session',fileName:'x.psd',bytes:psd()});
  await assert.rejects(()=>handoff.issueAgentToken({projectId:created.projectId,agentId:'unknown-agent'}),/not authorized/);
  const token = await handoff.issueAgentToken({projectId:created.projectId,agentId:'gpt6-semantic-planner'});
  const claimed = await handoff.claim({token,expectedRevision:1});
  assert.equal(claimed.status,'running');
  assert.equal(claimed.lease.agentId,'gpt6-semantic-planner');
  await assert.rejects(()=>handoff.claim({token,expectedRevision:1}),/revision changed or another agent/);
});

test('source access is hash-verified and agent results remain pending independent review', async () => {
  const {handoff,store} = setup(), bytes = psd();
  const created = await handoff.create({sessionToken:'valid-site-session',fileName:'x.psd',bytes});
  const token = await handoff.issueAgentToken({projectId:created.projectId,agentId:'sa-renderer'});
  const claimed = await handoff.claim({token,expectedRevision:1});
  const source = await handoff.readSource({token});
  assert.equal(source.sha256,created.sourceSha256);
  assert.deepEqual(source.bytes,bytes);
  const result = await handoff.complete({token,expectedRevision:claimed.revision,
    result:{status:'ready',sourceSha256:created.sourceSha256,artifacts:[{name:'masks.zip',sha256:'f'.repeat(64),bytes:100}]}});
  assert.equal(result.status,'awaiting-review');
  assert.equal(result.result.sourceSha256,created.sourceSha256);
  assert.notEqual(result.status,'approved');
  store.tamperSource(created.projectId);
  await assert.rejects(()=>handoff.readSource({token}),/failed SHA-256 verification/);
});

test('handoff rejects stale, wrong-source and malformed agent completion manifests', async () => {
  const {handoff} = setup(), created = await handoff.create({sessionToken:'valid-site-session',fileName:'x.psd',bytes:psd()});
  const token = await handoff.issueAgentToken({projectId:created.projectId,agentId:'sa-renderer'});
  const claimed = await handoff.claim({token,expectedRevision:1});
  await assert.rejects(()=>handoff.complete({token,expectedRevision:claimed.revision,
    result:{status:'ready',sourceSha256:'0'.repeat(64),artifacts:[{name:'masks.zip',sha256:'f'.repeat(64),bytes:100}] }}),/does not match the project source/);
  await assert.rejects(()=>handoff.complete({token,expectedRevision:1,
    result:{status:'ready',sourceSha256:created.sourceSha256,artifacts:[{name:'masks.zip',sha256:'f'.repeat(64),bytes:100}] }}),/lease or revision/);
});

test('internal contour access requires a live authorized agent token with source-read scope', async () => {
  const {handoff}=setup();
  const created=await handoff.create({sessionToken:'valid-site-session',fileName:'x.psd',bytes:psd()});
  await assert.rejects(()=>handoff.verifyAgentToken({
    token:created.token,projectId:created.projectId,requiredScopes:['job:read','job:source:read']
  }),/valid agent token/);
  const token=await handoff.issueAgentToken({projectId:created.projectId,agentId:'gpt6-semantic-planner'});
  const verified=await handoff.verifyAgentToken({
    token,projectId:created.projectId,requiredScopes:['job:read','job:source:read']
  });
  assert.equal(verified.agentId,'gpt6-semantic-planner');
  assert.equal(verified.projectId,created.projectId);
  await assert.rejects(()=>handoff.verifyAgentToken({
    token,projectId:'sa_zzzzzzzzzzzzzzzzzzzzzzzz',requiredScopes:['job:read','job:source:read']
  }),/valid agent token/);
});
