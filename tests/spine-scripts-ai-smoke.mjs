import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PLANNER = 'https://spine-plan-api.spine-animator-f8692224.workers.dev';
const GENERATOR = 'https://spine-generator.spine-animator-f8692224.workers.dev';
const ORIGIN = 'https://spineanimator.github.io';

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}
function syntheticPng() {
  const width = 64, height = 64;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const dx = x - 32, dy = y - 32;
      const inside = dx * dx + dy * dy <= 18 * 18;
      const p = 1 + x * 4;
      row[p] = 235; row[p + 1] = 72; row[p + 2] = 42; row[p + 3] = inside ? 255 : 0;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return { width, height, dataUrl: 'data:image/png;base64,' + png.toString('base64') };
}
async function jsonRequest(url, body, requestId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-request-id': requestId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${response.status} at ${url}`);
  return data;
}
function changedTransformKeyframes(skeleton) {
  const found = [];
  for (const [animationName, animation] of Object.entries(skeleton.animations || {})) {
    for (const [boneName, channels] of Object.entries(animation.bones || {})) {
      for (const property of ['translate', 'rotate', 'scale', 'shear']) {
        const keys = channels[property] || [];
        if (keys.length >= 2) {
          const values = keys.map(k => JSON.stringify(k));
          if (new Set(values).size > 1) found.push({ animationName, boneName, property, keyCount: keys.length, first: keys[0], last: keys[keys.length - 1] });
        }
      }
    }
  }
  return found;
}

const png = syntheticPng();
const layer = { id: 'synthetic_sprite', sourceName: 'synthetic_sprite', sourceIndex: 0, visible: true, opacity: 255,
  image: png.dataUrl, bounds: { x: 0, y: 0, width: png.width, height: png.height } };
const requestId = crypto.randomUUID();
const request = {
  image: png.dataUrl,
  canvas: { width: png.width, height: png.height },
  layers: [layer],
  description: 'Animate this single synthetic red circular sprite with a gentle left-right rotation, approximately -12 degrees to +12 degrees and back to center over 2 seconds. Keep translation and scale fixed. Include at least three distinct timestamps including the starting and ending setup pose.',
  instructions: 'Synthetic one-layer integration test only; this is not user artwork. Preserve the source layer ID, sourceName and bounds exactly. Frame zero must match the supplied source composition. Create a nonempty Spine clip with real numeric transform keyframes at distinct timestamps and at least one transform property with different values. Do not add, rename, merge or invent source layers. Do not return static fallback motion.'
};

const health = await fetch(PLANNER + '/api/health', { headers: { origin: ORIGIN }, signal: AbortSignal.timeout(15000) });
const healthData = await health.json().catch(() => ({}));
assert.equal(health.status, 200, 'planner health must be HTTP 200');
assert.equal(healthData.asyncPlanning, true, 'planner async API must be enabled');

const started = await jsonRequest(PLANNER + '/api/plan-async', request, requestId);
assert.ok(started.jobId, 'planner must return a jobId');
const deadline = Date.now() + 20 * 60 * 1000;
let plan = null, lastStatus = 'queued';
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 2500));
  const response = await fetch(PLANNER + '/api/plan-status?id=' + encodeURIComponent(started.jobId), {
    headers: { origin: ORIGIN }, signal: AbortSignal.timeout(15000)
  });
  const status = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(status?.error?.message || `Planner status HTTP ${response.status}`);
  lastStatus = status.status || 'unknown';
  if (status.status === 'complete' && status.plan) { plan = status.plan; break; }
  if (status.status === 'failed' || status.error) throw new Error(status.error?.message || 'Planner job failed');
  console.log(JSON.stringify({ stage: 'planning', status: lastStatus }));
}
assert.ok(plan, `planner did not complete before timeout (last status: ${lastStatus})`);
assert.ok(plan.scene && Array.isArray(plan.scene.clips) && plan.scene.clips.length > 0, 'planner must return a nonempty scene clip');

const sceneTracks = plan.scene.clips.flatMap(clip => clip.tracks || []);
const hasDistinctAuthoredTransform = sceneTracks.some(track => {
  if (!['x','y','rotation','scaleX','scaleY'].includes(track.property) || !Array.isArray(track.keys) || track.keys.length < 2) return false;
  return new Set(track.keys.map(key => key.value)).size > 1 && new Set(track.keys.map(key => key.time)).size > 1;
});
assert.ok(hasDistinctAuthoredTransform, 'planner must author a non-static transform track with distinct values and timestamps');

const buildResponse = await fetch(GENERATOR + '/api/build', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ canvas: request.canvas, scene: plan.scene, layers: [layer] }),
  signal: AbortSignal.timeout(60000)
});
if (!buildResponse.ok) {
  const error = await buildResponse.json().catch(() => ({}));
  throw new Error(error?.error?.message || `Generator HTTP ${buildResponse.status}`);
}
const zip = Buffer.from(await buildResponse.arrayBuffer());
assert.ok(zip.length > 1000, 'generator ZIP must contain real project data');
assert.equal(zip.subarray(0,4).toString('hex'), '504b0304', 'generator response must be a ZIP');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-scripts-ai-'));
const zipPath = path.join(temp, 'synthetic-spine.zip');
fs.writeFileSync(zipPath, zip);
execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' });
const manifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' }));
const skeleton = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'skeleton.json'], { encoding: 'utf8' }));
const motionTracks = changedTransformKeyframes(skeleton);
assert.ok(manifest.sceneBake?.keyCount > 1, 'manifest must report multiple baked keyframes');
assert.ok(manifest.sceneBake?.visualNodeCount > 0, 'manifest must report at least one visual node');
assert.ok(motionTracks.length > 0, 'Spine skeleton must contain a non-static transform track');
assert.equal(manifest.spine, '4.3.26');
assert.equal(manifest.releaseReady, false, 'synthetic smoke must not be marked release-ready');
assert.equal(manifest.renderEvidence?.status, 'not-rendered');
assert.equal(manifest.artisticApproval, 'pending');

console.log(JSON.stringify({
  ok: true,
  jobId: started.jobId,
  clipNames: Object.keys(skeleton.animations || {}),
  plannerTrackCount: sceneTracks.length,
  motionTracks,
  bakedKeyCount: manifest.sceneBake.keyCount,
  visualNodeCount: manifest.sceneBake.visualNodeCount,
  effectiveFps: manifest.sceneBake.keyframePolicy?.effectiveFps,
  zipBytes: zip.length,
  zipSha256: createHash('sha256').update(zip).digest('hex'),
  releaseReady: manifest.releaseReady,
  renderEvidence: manifest.renderEvidence
}, null, 2));
fs.rmSync(temp, { recursive: true, force: true });
