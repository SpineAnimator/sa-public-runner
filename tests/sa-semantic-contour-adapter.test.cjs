'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SA = require('../engine/sa-agent.js');
const Plan = require('../engine/semantic-anatomy-plan.js');
const Adapter = require('../engine/sa-semantic-contour-adapter.js');

const sha = 'e'.repeat(64);
async function fixture() {
  const rgba = new Uint8ClampedArray(4 * 2 * 4);
  for (let i = 0; i < 8; i++) rgba.set([10 + i, 30, 60, 255], i * 4);
  const source = { sha256: sha, width: 4, height: 2,
    layers: [{ id:'layer.body',left:0,top:0,width:4,height:2,rgba }] };
  const rect = (left,right) => ({layerId:'layer.body',role:'outer',
    points:[{x:left,y:0},{x:right,y:0},{x:right,y:2},{x:left,y:2}]});
  const proposal = {schema:'sa.semantic-anatomy-plan',version:1,status:'proposed',
    source:{sha256:sha,width:4,height:2},subject:{kind:'character',confidence:0.9},
    parts:[
      {id:'part.left',label:'left part',confidence:0.9,contours:[rect(0,2)]},
      {id:'part.right',label:'right part',confidence:0.9,contours:[rect(2,4)]}
    ],joints:[],relations:[]};
  const plan = await Plan.approveProposal({source,proposal,reviewReceipt:{token:'opaque'},
    verifyReviewReceipt:async(_receipt,binding)=>({valid:true,status:'approved',reviewerId:'independent',
      reviewId:'review-01',independentReviewerCount:2,independenceGroupCount:2,
      proposalSha256:binding.proposalSha256})});
  return {source,plan};
}

test('SA Tool Registry exposes semantic contour rendering with pixel reconstruction proof', async () => {
  const {source,plan} = await fixture();
  const registry = SA.createToolRegistry();
  Adapter.registerSemanticContourRendererTool(registry);
  assert.equal(registry.hasCapability(SA.CAPABILITIES.CONTOUR_RENDER), true);
  const result = await registry.resolve('vision.contour.render').run({context:{contourSource:source,semanticAnatomyPlan:plan}});
  assert.equal(result.status,'ready');
  assert.equal(result.pixelGatePassed,true);
  assert.equal(result.productionEligible,false);
  assert.ok(result.productionBlockers.length >= 2);
  assert.equal(result.reconstruction.status,'pass');
  assert.equal(result.rendered.metrics.exactPartition,true);
});

test('SA contour tool refuses unapproved plans and missing source RGBA', async () => {
  const registry = SA.createToolRegistry();
  Adapter.registerSemanticContourRendererTool(registry);
  const tool = registry.resolve('vision.contour.render');
  const {source,plan} = await fixture();
  await assert.rejects(() => tool.run({context:{contourSource:source,
    semanticAnatomyPlan:{...plan,status:'proposed',review:undefined}}}), /independent anatomy approval receipt/);
  await assert.rejects(() => tool.run({context:{semanticAnatomyPlan:plan}}), /exact source RGBA layers/);
});

test('SA contour adapter selects the minimum animated part set and keeps remaining pixels static', async () => {
  const {source,plan:base} = await fixture();
  const proposal = {
    schema:'sa.semantic-anatomy-plan',version:1,status:'proposed',
    source:{sha256:sha,width:4,height:2},subject:{kind:'character',confidence:0.9},
    parts:[
      {id:'part.left',label:'left part',confidence:0.9,motionRequirements:['arm.swing','elbow.bend'],
       contours:[{layerId:'layer.body',role:'outer',points:[{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2}]}]},
      {id:'part.right',label:'right part',confidence:0.9,motionRequirements:[],
       contours:[{layerId:'layer.body',role:'outer',points:[{x:2,y:0},{x:4,y:0},{x:4,y:2},{x:2,y:2}]}]}
    ],animationRequirements:[{id:'arm.swing'},{id:'elbow.bend'}],joints:[],relations:[]
  };
  const plan = await Plan.approveProposal({source,proposal,reviewReceipt:{token:'opaque'},
    verifyReviewReceipt:async(_receipt,binding)=>({valid:true,status:'approved',reviewerId:'reviewer',
      reviewId:'review-budget',independentReviewerCount:2,independenceGroupCount:2,
      proposalSha256:binding.proposalSha256})});
  const registry=SA.createToolRegistry();Adapter.registerSemanticContourRendererTool(registry);
  const result=await registry.resolve('vision.contour.render').run({context:{contourSource:source,semanticAnatomyPlan:plan}});
  assert.deepEqual(result.animatedPartIds,['part.left']);
  assert.deepEqual(result.staticPartIds,['part.right']);
  assert.equal(result.layerBudget.cost.layers,1);
  assert.equal(result.reconstruction.status,'pass');
});
