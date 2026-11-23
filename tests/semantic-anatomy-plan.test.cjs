'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Plan = require('../engine/semantic-anatomy-plan.js');

const sha = 'd'.repeat(64);
function fixture() {
  const source = { sha256: sha, width: 4, height: 2,
    layers: [{ id: 'layer.body', left: 0, top: 0, width: 4, height: 2 }] };
  const rect = (left, right) => ({ layerId: 'layer.body', role: 'outer',
    points: [{x:left,y:0},{x:right,y:0},{x:right,y:2},{x:left,y:2}] });
  const proposal = { schema: 'sa.semantic-anatomy-plan', version: 1, status: 'proposed',
    source: { sha256: sha, width: 4, height: 2 },
    subject: { kind: 'character', confidence: 0.98 },
    parts: [
      { id: 'part.left-arm', label: 'left arm', confidence: 0.97, contours: [rect(0,2)] },
      { id: 'part.torso', label: 'torso', confidence: 0.99, contours: [rect(2,4)] }
    ],
    joints: [{ id: 'joint.shoulder', kind: 'shoulder', x: 2, y: 1, confidence: 0.9,
      partIds: ['part.left-arm','part.torso'] }],
    relations: [{ type: 'attached-to', from: 'part.left-arm', to: 'part.torso', confidence: 0.8 }],
    provenance: { provider: 'chatgpt.com', model: 'GPT-6' } };
  return { source, proposal };
}

test('GPT semantic anatomy proposal is source-bound and remains explicitly unapproved', () => {
  const { source, proposal } = fixture();
  const validated = Plan.validateProposal({ source, proposal });
  assert.equal(validated.status, 'proposed');
  assert.equal(validated.source.sha256, sha);
  assert.equal(validated.parts.length, 2);
  assert.equal(validated.joints[0].kind, 'shoulder');
  assert.equal(validated.provenance.independentApproval, 'pending');
  assert.equal(Object.hasOwn(validated, 'review'), false);
});

test('semantic anatomy validation rejects source drift, self-issued review and invalid joints', () => {
  const { source, proposal } = fixture();
  assert.throws(() => Plan.validateProposal({ source, proposal: { ...proposal, source: { ...proposal.source, sha256: 'e'.repeat(64) } } }), /exact source PSD/);
  assert.throws(() => Plan.validateProposal({ source, proposal: { ...proposal, review: { status: 'approved' } } }), /cannot supply its own independent review/);
  assert.throws(() => Plan.validateProposal({ source, proposal: { ...proposal, joints: [{ id:'joint.bad',kind:'elbow',x:99,y:1,confidence:1,partIds:['part.left-arm'] }] } }), /invalid source coordinates/);
});

test('only a server-verified, multi-group receipt bound to the canonical proposal can approve contours', async () => {
  const { source, proposal } = fixture();
  const approved = await Plan.approveProposal({ source, proposal, reviewReceipt: { opaque: 'signed-proof' },
    verifyReviewReceipt: async (_receipt, binding) => ({
      valid: true, status: 'approved', reviewerId: 'review.coordinator',
      reviewId: 'review.2026.11.23', independentReviewerCount: 4, independenceGroupCount: 3,
      proposalSha256: binding.proposalSha256
    }) });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.review.independenceGroupCount, 3);
  assert.match(approved.review.proposalSha256, /^[a-f0-9]{64}$/);
});

test('self-asserted or stale approval receipts cannot release a semantic anatomy plan', async () => {
  const { source, proposal } = fixture();
  await assert.rejects(() => Plan.approveProposal({ source, proposal, reviewReceipt: { approved: true },
    verifyReviewReceipt: async () => ({ valid: true, status: 'approved', reviewerId:'x', reviewId:'y',
      independentReviewerCount: 1, independenceGroupCount: 1, proposalSha256: '0'.repeat(64) }) }),
    /did not approve this exact semantic anatomy proposal/);
});
