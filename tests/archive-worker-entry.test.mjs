import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../workers/archive/index.mjs';

function memoryKV(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    }
  };
}

const readyEntries = {
  'system/health': 'ready',
  'snapshots/2026-11-12-branches.json': JSON.stringify({ branches: [{ name: 'main' }] }),
  'system/archive-payloads-status': JSON.stringify({ status: 'uploaded', count: 11 })
};

test('GET /health keeps the manifest gate read-only and reports real KV readiness', async () => {
  const env = { ARCHIVE: memoryKV(readyEntries), SESSION_SECRET: 'test-session-secret' };
  const response = await worker.fetch(new Request('https://archive.test/health'), env, {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.service, '3spine-archive');
  assert.equal(body.status, 'ready');
  assert.equal(body.storage, 'workers-kv');
  assert.equal(body.branchSnapshotCount, 1);
  assert.equal(body.archivePayloads, 'uploaded');
  assert.equal(body.archivedWorkerCount, 11);
  assert.equal(body.publicWrite, false);
  assert.equal(body.assetUpload, true);
  assert.equal(body.privateArchive, false);
});

test('GET /health fails closed when the manifest or archive payload receipt is missing', async () => {
  const env = { ARCHIVE: memoryKV(), SESSION_SECRET: 'test-session-secret' };
  const response = await worker.fetch(new Request('https://archive.test/health'), env, {});
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.status, 'manifest-ready');
  assert.equal(body.publicWrite, false);
});

test('GET /api/health reports upload availability separately from private GitHub storage', async () => {
  const env = {
    ARCHIVE: memoryKV(readyEntries),
    SESSION_SECRET: 'test-session-secret',
    GENERATION_REPOSITORY: 'SpineAnimator/spine-animation-library'
  };
  const response = await worker.fetch(new Request('https://archive.test/api/health'), env, {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.assetUpload, true);
  assert.equal(body.privateArchive, false);
  assert.equal(body.fallbackProvider, 'cloudflare-kv');
});
