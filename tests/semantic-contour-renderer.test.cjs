'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Renderer = require('../engine/semantic-contour-renderer.js');

const sha = 'a'.repeat(64);
function makeSource(width, height, paint) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    rgba[offset] = 20 + x; rgba[offset + 1] = 40 + y; rgba[offset + 2] = 90; rgba[offset + 3] = 255;
  }
  if (paint) paint(rgba);
  return { width, height, sha256: sha, layers: [{ id: 'layer.body', left: 0, top: 0, width, height, rgba }] };
}
function polygon(left, top, right, bottom, role = 'outer') {
  return { role, points: [{x:left,y:top},{x:right,y:top},{x:right,y:bottom},{x:left,y:bottom}] };
}
function plan(width, height, parts, review = { status: 'approved', reviewerId: 'reviewer.independent', reviewId: 'review.001' }) {
  return { schema: 'sa.semantic-anatomy-plan', version: 1, status: 'approved',
    source: { sha256: sha, width, height }, review, parts };
}
function part(id, contours) { return { id, label: id, confidence: 0.99, contours }; }

test('approved semantic contours render exact transparent RGBA partitions in source coordinates', () => {
  const source = makeSource(4, 3);
  const result = Renderer.renderApprovedContours({ source, plan: plan(4, 3, [
    part('part.left-arm', [{ layerId: 'layer.body', ...polygon(0, 0, 2, 3) }]),
    part('part.torso', [{ layerId: 'layer.body', ...polygon(2, 0, 4, 3) }])
  ]) });
  assert.equal(result.status, 'rendered');
  assert.equal(result.metrics.sourcePixels, 12);
  assert.equal(result.metrics.assignedPixels, 12);
  assert.equal(result.metrics.exactPartition, true);
  assert.deepEqual(result.parts.map(p => [p.partId, p.pixelCount]), [['part.left-arm', 6], ['part.torso', 6]]);
  assert.equal(result.parts[0].rgba[(0 * 4 + 0) * 4 + 3], 255);
  assert.equal(result.parts[0].rgba[(0 * 4 + 3) * 4 + 3], 0);
});

test('renderer clips semantic masks to original source alpha and ignores transparent RGB', () => {
  const source = makeSource(3, 3, rgba => { rgba[(1 * 3 + 1) * 4 + 3] = 0; });
  const result = Renderer.renderApprovedContours({ source, plan: plan(3, 3, [
    part('part.object', [{ layerId: 'layer.body', ...polygon(0, 0, 3, 3) }])
  ]) });
  assert.equal(result.metrics.sourcePixels, 8);
  assert.equal(result.parts[0].pixelCount, 8);
  assert.equal(result.parts[0].alphaMask[4], 0);
  assert.equal(result.parts[0].rgba[4 * 4 + 3], 0);
});

test('holes are subtracted independent of contour ordering', () => {
  const source = makeSource(5, 5);
  const result = Renderer.renderApprovedContours({ source, plan: plan(5, 5, [
    part('part.ring', [
      { layerId: 'layer.body', ...polygon(1, 1, 4, 4, 'hole') },
      { layerId: 'layer.body', ...polygon(0, 0, 5, 5, 'outer') }
    ]),
    part('part.center', [{ layerId: 'layer.body', ...polygon(1, 1, 4, 4) }])
  ]) });
  assert.equal(result.metrics.sourcePixels, 25);
  assert.equal(result.parts.find(p => p.partId === 'part.ring').pixelCount, 16);
  assert.equal(result.parts.find(p => p.partId === 'part.center').pixelCount, 9);
});

test('renderer fails closed when independent approval is absent', () => {
  const source = makeSource(2, 2);
  assert.throws(() => Renderer.renderApprovedContours({ source, plan: plan(2, 2, [
    part('part.object', [{ layerId: 'layer.body', ...polygon(0, 0, 2, 2) }])
  ], { status: 'proposed', reviewerId: 'model', reviewId: 'none' }) }), /independent anatomy approval receipt/);
});

test('renderer rejects source identity mismatch and unknown source layer references', () => {
  const source = makeSource(2, 2);
  const valid = plan(2, 2, [part('part.object', [{ layerId: 'layer.body', ...polygon(0, 0, 2, 2) }])]);
  assert.throws(() => Renderer.renderApprovedContours({ source, plan: { ...valid, source: { ...valid.source, sha256: 'b'.repeat(64) } } }), /source identity/);
  assert.throws(() => Renderer.renderApprovedContours({ source, plan: plan(2, 2, [
    part('part.object', [{ layerId: 'layer.missing', ...polygon(0, 0, 2, 2) }])
  ]) }), /unknown source layer/);
});

test('renderer rejects overlap and missing pixels rather than guessing a partition', () => {
  const source = makeSource(4, 2);
  assert.throws(() => Renderer.renderApprovedContours({ source, plan: plan(4, 2, [
    part('part.a', [{ layerId: 'layer.body', ...polygon(0, 0, 3, 2) }]),
    part('part.b', [{ layerId: 'layer.body', ...polygon(2, 0, 4, 2) }])
  ]) }), /partition failed: overlap=/);
  assert.throws(() => Renderer.renderApprovedContours({ source, plan: plan(4, 2, [
    part('part.a', [{ layerId: 'layer.body', ...polygon(0, 0, 2, 2) }])
  ]) }), /partition failed: overlap=0, missing=4/);
});

test('renderer rejects self-intersecting contours and malformed coordinates', () => {
  const source = makeSource(4, 4);
  assert.throws(() => Renderer.renderApprovedContours({ source, plan: plan(4, 4, [
    part('part.bowtie', [{ layerId: 'layer.body', points: [{x:0,y:0},{x:4,y:4},{x:0,y:4},{x:4,y:0}] }])
  ]) }), /self-intersects/);
  assert.throws(() => Renderer.renderApprovedContours({ source, plan: plan(4, 4, [
    part('part.outside', [{ layerId: 'layer.body', points: [{x:-1,y:0},{x:4,y:0},{x:4,y:4}] }])
  ]) }), /outside source canvas/);
});

test('fully transparent source layers do not require fabricated semantic contours', () => {
  const source = makeSource(3, 3);
  source.layers.push({ id:'layer.empty',left:0,top:0,width:3,height:3,rgba:new Uint8ClampedArray(3*3*4) });
  const result = Renderer.renderApprovedContours({ source, plan: plan(3, 3, [
    part('part.object', [{ layerId:'layer.body', ...polygon(0,0,3,3) }])
  ]) });
  assert.equal(result.metrics.sourceLayerCount,1);
  assert.equal(result.layers.length,1);
  assert.equal(result.metrics.exactPartition,true);
});
