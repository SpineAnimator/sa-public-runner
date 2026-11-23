'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Optimizer = require('../engine/layer-budget-optimizer.js');

const cost = (layers, bones, attachments) => ({ layers, bones, attachments });
test('optimizer selects the exact minimum part set covering the requested motion requirements', () => {
  const result = Optimizer.optimizeLayerBudget({
    requirements: [{id:'arm.swing'}, {id:'elbow.bend'}, {id:'torso.turn'}],
    candidates: [
      {id:'arm.whole', covers:['arm.swing','elbow.bend'], cost:cost(1,1,1)},
      {id:'torso', covers:['torso.turn'], cost:cost(1,1,1)},
      {id:'arm.upper', covers:['arm.swing'], cost:cost(1,1,1)},
      {id:'arm.lower', covers:['elbow.bend'], cost:cost(1,1,1)},
      {id:'body.combined', covers:['arm.swing','elbow.bend','torso.turn'], cost:cost(1,1,1)}
    ]
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.selectedPartIds, ['body.combined']);
  assert.deepEqual(result.cost, {layers:1,bones:1,attachments:1,partCount:1});
  assert.equal(result.exactMinimum, true);
});

test('optimizer uses lexicographic layer, bone and attachment costs with explicit required parts', () => {
  const result = Optimizer.optimizeLayerBudget({
    requirements: [{id:'face.look'}, {id:'head.tilt'}],
    mustKeep: ['eye.details'],
    candidates: [
      {id:'eye.details', covers:['face.look'], cost:cost(1,0,1)},
      {id:'head.rig', covers:['head.tilt'], cost:cost(1,1,1)},
      {id:'head.merged', covers:['face.look','head.tilt'], cost:cost(1,2,2)},
      {id:'head.mesh', covers:['head.tilt'], cost:cost(0,2,1)}
    ]
  });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.selectedPartIds, ['eye.details','head.mesh']);
  assert.deepEqual(result.cost, {layers:1,bones:2,attachments:2,partCount:2});
});

test('optimizer blocks when required motion cannot be represented by any candidate', () => {
  const result = Optimizer.optimizeLayerBudget({
    requirements: [{id:'tail.wave'}, {id:'wing.fold'}],
    candidates: [{id:'tail', covers:['tail.wave'], cost:cost(1,1,1)}]
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.missingRequirements, ['wing.fold']);
  assert.equal(result.exactMinimum, false);
});

test('optimizer rejects unknown requirement references and oversized exact-search requests', () => {
  assert.throws(() => Optimizer.optimizeLayerBudget({
    requirements:[{id:'arm'}], candidates:[{id:'unknown',covers:['leg'],cost:cost(1,1,1)}]
  }), /unknown requirement/);
  assert.throws(() => Optimizer.optimizeLayerBudget({
    requirements:Array.from({length:21},(_,i)=>({id:'r'+i})),
    candidates:[{id:'part',covers:['r0'],cost:cost(1,1,1)}]
  }), /1..20 explicit animation requirements/);
});
