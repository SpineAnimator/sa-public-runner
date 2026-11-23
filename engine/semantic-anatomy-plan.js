'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SASemanticAnatomyPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const Renderer = typeof module === 'object' && module.exports
    ? require('./semantic-contour-renderer.js') : root.SASemanticContourRenderer;
  const fail = message => { throw new Error('SemanticAnatomyPlan: ' + message); };
  const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value) :
    Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' :
      '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  async function digest(value) {
    const cryptoApi = root.crypto || (typeof require === 'function' ? require('node:crypto').webcrypto : null);
    if (!cryptoApi?.subtle?.digest) fail('WebCrypto SHA-256 is unavailable');
    const bytes = new TextEncoder().encode(stable(value));
    const hash = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes));
    return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
  function validateProposal({ source, proposal } = {}) {
    if (!object(source) || !Number.isInteger(source.width) || !Number.isInteger(source.height) ||
        typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256) ||
        !Array.isArray(source.layers) || !source.layers.length)
      fail('exact PSD source identity and layer manifest are required');
    if (!object(proposal) || proposal.schema !== 'sa.semantic-anatomy-plan' ||
        proposal.version !== 1 || proposal.status !== 'proposed')
      fail('GPT semantic output must be an unapproved sa.semantic-anatomy-plan v1 proposal');
    if (proposal.review !== undefined) fail('a model proposal cannot supply its own independent review receipt');
    if (!object(proposal.source) || proposal.source.sha256 !== source.sha256 ||
        proposal.source.width !== source.width || proposal.source.height !== source.height)
      fail('proposal is not bound to the exact source PSD');
    const layerIds = new Set(source.layers.map(layer => layer && layer.id).filter(id => typeof id === 'string'));
    if (layerIds.size !== source.layers.length) fail('source layer IDs must be unique and stable');
    const draft = { ...proposal, status: 'approved',
      review: { status: 'approved', reviewerId: 'validation-only', reviewId: 'validation-only' } };
    const normalizedParts = Renderer.normalizePlan(draft, source, layerIds);
    const animationRequirements = proposal.animationRequirements === undefined ? [] : proposal.animationRequirements;
    if (!Array.isArray(animationRequirements) || animationRequirements.length > 20)
      fail('animation requirements must be a bounded array of at most 20 entries');
    const requirementIds = new Set();
    const requirements = animationRequirements.map((requirement, index) => {
      if (!object(requirement) || !safeId(requirement.id) || requirementIds.has(requirement.id))
        fail('animation requirement ' + index + ' has an invalid or duplicate ID');
      requirementIds.add(requirement.id);
      return { id: requirement.id, label: typeof requirement.label === 'string' ? requirement.label.slice(0,120) : requirement.id };
    });
    const rawParts = new Map(proposal.parts.map(part => [part.id, part]));
    const parts = normalizedParts.map(part => {
      const raw = rawParts.get(part.id), motionRequirements = raw.motionRequirements === undefined ? [] : raw.motionRequirements;
      if (!Array.isArray(motionRequirements) || motionRequirements.some(id => !requirementIds.has(id)))
        fail('part ' + part.id + ' references an unknown animation requirement');
      return { ...part, motionRequirements: [...new Set(motionRequirements)] };
    });
    if (!Array.isArray(proposal.joints) || proposal.joints.length > 2000)
      fail('joint hypotheses must be a bounded array');
    const jointIds = new Set();
    const subjectKind = typeof proposal.subject?.kind === 'string' && proposal.subject.kind.trim()
      ? proposal.subject.kind.slice(0, 120) : 'unknown';
    const subjectConfidence = proposal.subject?.confidence === undefined ? 0 : proposal.subject.confidence;
    if (typeof subjectConfidence !== 'number' || !Number.isFinite(subjectConfidence) ||
        subjectConfidence < 0 || subjectConfidence > 1) fail('subject confidence must be 0..1');
    const joints = proposal.joints.map((joint, index) => {
      if (!object(joint) || !safeId(joint.id) || jointIds.has(joint.id) ||
          typeof joint.kind !== 'string' || !joint.kind.trim() || joint.kind.length > 100)
        fail('joint hypothesis ' + index + ' is malformed');
      jointIds.add(joint.id);
      const x = joint.x, y = joint.y, confidence = joint.confidence;
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > source.width ||
          typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > source.height ||
          typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
        fail('joint hypothesis ' + joint.id + ' has invalid source coordinates or confidence');
      if (!Array.isArray(joint.partIds) || !joint.partIds.length ||
          joint.partIds.some(id => !parts.some(part => part.id === id)))
        fail('joint hypothesis ' + joint.id + ' must reference known semantic parts');
      return { id: joint.id, kind: joint.kind, x, y, confidence, partIds: [...new Set(joint.partIds)] };
    });
    if (!Array.isArray(proposal.relations) || proposal.relations.length > 10000)
      fail('anatomical relation hypotheses must be a bounded array');
    const partIds = new Set(parts.map(part => part.id));
    const allowedRelations = new Set(['parent','attached-to','occludes','overlaps','hinge-at','pivot-at','connected-to','same-object']);
    const relations = proposal.relations.map((relation, index) => {
      if (!object(relation) || !allowedRelations.has(relation.type) ||
          !partIds.has(relation.from) || !partIds.has(relation.to) || relation.from === relation.to)
        fail('anatomical relation ' + index + ' references unknown parts or an unsupported relation');
      const confidence = relation.confidence;
      if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
        fail('anatomical relation confidence must be 0..1');
      return { type: relation.type, from: relation.from, to: relation.to, confidence };
    });
    return Object.freeze({ schema: 'sa.semantic-anatomy-plan', version: 1, status: 'proposed',
      source: { sha256: source.sha256.toLowerCase(), width: source.width, height: source.height },
      subject: { kind: subjectKind, confidence: subjectConfidence },
      parts, joints, relations, animationRequirements: requirements,
      provenance: { provider: typeof proposal.provenance?.provider === 'string' ? proposal.provenance.provider.slice(0,120) : 'unspecified',
        model: typeof proposal.provenance?.model === 'string' ? proposal.provenance.model.slice(0,120) : 'unspecified',
        sourceBound: true, independentApproval: 'pending' } });
  }
  async function approveProposal({ source, proposal, reviewReceipt, verifyReviewReceipt } = {}) {
    const validated = validateProposal({ source, proposal });
    if (typeof verifyReviewReceipt !== 'function') fail('server-side independent review receipt verifier is required');
    const proposalSha256 = await digest(validated);
    const verified = await verifyReviewReceipt(reviewReceipt, { source, proposal: validated, proposalSha256 });
    if (!object(verified) || verified.valid !== true || verified.status !== 'approved' ||
        verified.proposalSha256 !== proposalSha256 ||
        typeof verified.reviewerId !== 'string' || !verified.reviewerId.trim() ||
        typeof verified.reviewId !== 'string' || !verified.reviewId.trim() ||
        !Number.isInteger(verified.independentReviewerCount) || verified.independentReviewerCount < 2 ||
        !Number.isInteger(verified.independenceGroupCount) || verified.independenceGroupCount < 2)
      fail('independent reviewers did not approve this exact semantic anatomy proposal');
    return Object.freeze({ ...validated, status: 'approved',
      review: { status: 'approved', reviewerId: verified.reviewerId,
        reviewId: verified.reviewId, independentReviewerCount: verified.independentReviewerCount,
        independenceGroupCount: verified.independenceGroupCount,
        proposalSha256: verified.proposalSha256 } });
  }
  return Object.freeze({ validateProposal, approveProposal });
});
