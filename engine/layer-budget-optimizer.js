'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SALayerBudgetOptimizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const fail = message => { throw new Error('LayerBudgetOptimizer: ' + message); };
  const compareCost = (a, b) => a.layers - b.layers || a.bones - b.bones ||
    a.attachments - b.attachments || a.partCount - b.partCount;
  function optimizeLayerBudget({ requirements, candidates, mustKeep = [], maxStates = 1000000 } = {}) {
    if (!Array.isArray(requirements) || !requirements.length || requirements.length > 20)
      fail('requirements must contain 1..20 explicit animation requirements');
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > 256)
      fail('candidates must contain 1..256 source-backed semantic parts');
    if (!Array.isArray(mustKeep) || mustKeep.length > 256) fail('mustKeep must be a bounded array');
    if (!Number.isInteger(maxStates) || maxStates < 1 || maxStates > 1000000) fail('invalid state budget');
    const reqIds = new Set();
    for (const req of requirements) {
      if (!req || typeof req.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(req.id) || reqIds.has(req.id))
        fail('requirement IDs must be unique and safe');
      reqIds.add(req.id);
    }
    const byId = new Map(), normalized = candidates.map(candidate => {
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id.trim() || byId.has(candidate.id))
        fail('candidate IDs must be unique');
      if (!Array.isArray(candidate.covers) || !candidate.covers.length) fail('candidate ' + candidate.id + ' must declare covered requirements');
      const covers = [...new Set(candidate.covers)];
      if (covers.some(id => !reqIds.has(id))) fail('candidate ' + candidate.id + ' covers an unknown requirement');
      const cost = candidate.cost || {};
      const layers = cost.layers, bones = cost.bones, attachments = cost.attachments;
      for (const [name, value] of Object.entries({ layers, bones, attachments })) {
        if (!Number.isInteger(value) || value < 0 || value > 10000) fail('candidate ' + candidate.id + ' has invalid ' + name + ' cost');
      }
      if (layers + bones + attachments < 1) fail('candidate ' + candidate.id + ' cost cannot be zero');
      const item = { id: candidate.id, covers, cost: { layers, bones, attachments } };
      byId.set(item.id, item); return item;
    });
    const forced = [...new Set(mustKeep)];
    if (forced.some(id => !byId.has(id))) fail('mustKeep references an unknown candidate');
    const bit = new Map(requirements.map((req, index) => [req.id, 1 << index]));
    const fullMask = (1 << requirements.length) - 1;
    const score = selected => {
      const total = { layers: 0, bones: 0, attachments: 0, partCount: selected.size };
      for (const id of selected) {
        const cost = byId.get(id).cost;
        total.layers += cost.layers; total.bones += cost.bones; total.attachments += cost.attachments;
      }
      return total;
    };
    const maskFor = selected => {
      let mask = 0;
      for (const id of selected) for (const req of byId.get(id).covers) mask |= bit.get(req);
      return mask;
    };
    const initial = new Set(forced);
    const initialCost = score(initial);
    let states = new Map([[maskFor(initial), { selected: initial, cost: initialCost }]]);
    const forcedSet = new Set(forced);
    for (const candidate of normalized) {
      if (forcedSet.has(candidate.id)) continue;
      const next = new Map(states);
      for (const state of states.values()) {
        const selected = new Set(state.selected); selected.add(candidate.id);
        const mask = maskFor(selected), cost = score(selected), previous = next.get(mask);
        if (!previous || compareCost(cost, previous.cost) < 0)
          next.set(mask, { selected, cost });
      }
      states = next;
      if (states.size > maxStates) fail('exact optimization exceeded the bounded state budget');
    }
    const solution = states.get(fullMask);
    if (!solution) {
      const covered = new Set([...states.values()].flatMap(state => [...state.selected].flatMap(id => byId.get(id).covers)));
      const missingRequirements = requirements.filter(req => !covered.has(req.id)).map(req => req.id);
      return Object.freeze({ schema: 'sa.layer-budget', version: 1, status: 'blocked',
        reason: 'No candidate set covers every required animation capability.',
        missingRequirements, selectedPartIds: [], cost: null, exactMinimum: false });
    }
    const selectedPartIds = [...solution.selected].sort();
    return Object.freeze({ schema: 'sa.layer-budget', version: 1, status: 'ready',
      selectedPartIds, omittedPartIds: normalized.map(item => item.id).filter(id => !solution.selected.has(id)).sort(),
      coveredRequirements: requirements.map(req => req.id), cost: solution.cost,
      objective: ['minimum layers', 'then minimum bones', 'then minimum attachments', 'then minimum parts'],
      exactMinimum: true,
      evidence: { method: 'bounded exact set-cover dynamic programming',
        requirementCount: requirements.length, candidateCount: normalized.length,
        exploredStates: states.size, mustKeep: forced } });
  }
  return Object.freeze({ optimizeLayerBudget });
});
