'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Renderer = require('../engine/semantic-contour-renderer.js');
const QA = require('../engine/reconstruction-qa.js');

const sha = 'b'.repeat(64);
function fixture() {
  const rgba = new Uint8ClampedArray(4 * 3 * 4);
  for (let i = 0; i < 12; i++) rgba.set([30 + i, 80, 120, 255], i * 4);
  const source = { sha256: sha, width: 4, height: 3,
    layers: [{ id: 'layer.body', left: 0, top: 0, width: 4, height: 3, rgba }] };
  const polygon = (left, right) => ({ layerId: 'layer.body', role: 'outer',
    points: [{x:left,y:0},{x:right,y:0},{x:right,y:3},{x:left,y:3}] });
  const plan = { schema: 'sa.semantic-anatomy-plan', version: 1, status: 'approved',
    source: { sha256: sha, width: 4, height: 3 },
    review: { status: 'approved', reviewerId: 'art-reviewer', reviewId: 'review.22' },
    parts: [
      { id: 'part.left', label: 'left part', confidence: 0.98, contours: [polygon(0, 2)] },
      { id: 'part.right', label: 'right part', confidence: 0.97, contours: [polygon(2, 4)] }
    ] };
  const rendered = Renderer.renderApprovedContours({ source, plan });
  return { source, rendered };
}

test('reconstruction QA proves exact visible RGBA preservation for all partitioned source pixels', () => {
  const { source, rendered } = fixture();
  const result = QA.verifyRenderedPartition({ source, rendered });
  assert.equal(result.status, 'pass');
  assert.equal(result.pixelExact, true);
  assert.equal(result.metrics.sourcePixels, 12);
  assert.equal(result.metrics.reconstructedPixels, 12);
  assert.equal(result.metrics.mismatchPixels, 0);
  assert.equal(result.metrics.overlapPixels, 0);
  assert.equal(result.metrics.missingPixels, 0);
  assert.match(result.scope.doesNotVerify.join(' '), /anatomical correctness/);
});

test('reconstruction QA detects changed source RGB or alpha in a rendered part', () => {
  const { source, rendered } = fixture();
  rendered.parts[0].rgba[0] ^= 0xff;
  const result = QA.verifyRenderedPartition({ source, rendered });
  assert.equal(result.status, 'fail');
  assert.equal(result.pixelExact, false);
  assert.equal(result.metrics.mismatchPixels, 1);
});

test('reconstruction QA detects mask overlaps and missing source pixels', () => {
  const { source, rendered } = fixture();
  rendered.parts[1].alphaMask[0] = 1;
  rendered.parts[1].rgba.set(rendered.parts[0].rgba.subarray(0, 4), 0);
  rendered.parts[1].alphaMask[11] = 0;
  const result = QA.verifyRenderedPartition({ source, rendered });
  assert.equal(result.status, 'fail');
  assert.equal(result.metrics.overlapPixels, 1);
  assert.equal(result.metrics.missingPixels, 1);
});

test('reconstruction QA refuses source hash and geometry mismatches', () => {
  const { source, rendered } = fixture();
  assert.throws(() => QA.verifyRenderedPartition({ source: { ...source, sha256: 'c'.repeat(64) }, rendered }), /source identity/);
  const altered = { ...rendered, parts: rendered.parts.map(part => ({ ...part, left: part.left + 1 })) };
  assert.throws(() => QA.verifyRenderedPartition({ source, rendered: altered }), /geometry does not match/);
});
