'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SASemanticContourAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const Renderer = typeof module === 'object' && module.exports
    ? require('./semantic-contour-renderer.js') : root.SASemanticContourRenderer;
  const QA = typeof module === 'object' && module.exports
    ? require('./reconstruction-qa.js') : root.SAReconstructionQA;
  const Budget = typeof module === 'object' && module.exports
    ? require('./layer-budget-optimizer.js') : root.SALayerBudgetOptimizer;
  function fail(message) { throw new Error('SA Semantic Contour Adapter: ' + message); }
  function registerSemanticContourRendererTool(registry, options = {}) {
    if (!registry || typeof registry.register !== 'function') fail('Tool Registry is required');
    const renderer = options.renderer || Renderer;
    const qa = options.qa || QA;
    if (!renderer || typeof renderer.renderApprovedContours !== 'function' ||
        !qa || typeof qa.verifyRenderedPartition !== 'function' ||
        !Budget || typeof Budget.optimizeLayerBudget !== 'function') fail('renderer, layer budget optimizer and reconstruction QA are required');
    return registry.register({
      id: options.toolId || 'sa.semantic-contour-renderer',
      capabilities: ['vision.contour.render'],
      priority: Number.isFinite(options.priority) ? options.priority : 100,
      run: async ({ context = {}, dependencies = {}, operation = {} } = {}) => {
        const upstreamSource = dependencies['source.inspect']?.contourSource ||
          dependencies['vision.analyze']?.contourSource;
        const source = operation.inputs?.contourSource || context.contourSource || upstreamSource;
        const upstreamPlan = dependencies['animation.plan']?.semanticAnatomyPlan ||
          dependencies['vision.analyze']?.semanticAnatomyPlan;
        const plan = operation.inputs?.semanticAnatomyPlan || context.semanticAnatomyPlan || upstreamPlan;
        if (!source || !Array.isArray(source.layers) || !source.layers.length)
          fail('exact source RGBA layers and their source hash are required');
        if (!plan || plan.schema !== 'sa.semantic-anatomy-plan')
          fail('A valid semantic anatomy plan is required');
        let layerBudget = null;
        if (Array.isArray(plan.animationRequirements) && plan.animationRequirements.length) {
          const candidates = plan.parts.map(part => ({
            id: part.id, covers: part.motionRequirements || [],
            // Cost is fixed by SA: one dynamic part maps to one layer, one bone
            // and one attachment. The model cannot lower its own optimization cost.
            cost: { layers: 1, bones: 1, attachments: 1 }
          })).filter(candidate => candidate.covers.length);
          layerBudget = Budget.optimizeLayerBudget({ requirements: plan.animationRequirements, candidates });
          if (layerBudget.status !== 'ready') fail('no sufficient layer budget for the requested animation: ' + layerBudget.missingRequirements.join(', '));
        }
        const rendered = renderer.renderApprovedContours({ source, plan });
        const reconstruction = qa.verifyRenderedPartition({ source, rendered });
        if (reconstruction.status !== 'pass' || reconstruction.pixelExact !== true)
          fail('pixel reconstruction QA did not pass');
        return Object.freeze({
          status: 'ready', backend: 'sa-semantic-contour-renderer',
          rendered, reconstruction, layerBudget,
          animatedPartIds: layerBudget ? layerBudget.selectedPartIds : [],
          staticPartIds: layerBudget ? plan.parts.map(part => part.id).filter(id => !layerBudget.selectedPartIds.includes(id)) : plan.parts.map(part => part.id),
          pixelGatePassed: true, productionEligible: false,
          productionBlockers: ['Private site-to-agent storage is not configured in the deployed Worker.',
            'Official Spine Pro 4.3.26 import/export and independent animation-art review are not verified.'],
          limitations: ['Semantic identity is only as reliable as the approved anatomy plan.',
            'This operation does not verify Spine 4.3 import or animation quality.']
        });
      }
    });
  }
  return Object.freeze({ registerSemanticContourRendererTool });
});
