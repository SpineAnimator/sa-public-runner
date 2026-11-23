'use strict';
(function(){

function fail(message) {
  throw new Error('SA ChatGPT Review Adapter: ' + message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compactScene(scene) {
  if (!object(scene)) fail('Scene IR is required');
  return {
    schema: scene.schema,
    version: scene.version,
    source: scene.source,
    entities: (Array.isArray(scene.entities) ? scene.entities : []).slice(0, 256).map(entity => ({
      id: entity.id,
      kind: entity.kind,
      bounds: entity.bounds,
      sourceRefs: entity.sourceRefs,
      hypotheses: entity.hypotheses
    })),
    relations: (Array.isArray(scene.relations) ? scene.relations : []).slice(0, 256),
    evidence: (Array.isArray(scene.evidence) ? scene.evidence : []).slice(0, 256).map(item => ({
      id: item.id, kind: item.kind, entityId: item.entityId,
      confidence: item.confidence, sourceRef: item.sourceRef
    }))
  };
}

function normalizeAssetLinks(context = {}) {
  const manifest = Array.isArray(context.assetManifest) ? context.assetManifest : [];
  if (manifest.length > 8) fail('at most eight asset links may be attached to one review');
  return manifest.map(item => {
    if (!object(item) || typeof item.url !== 'string') fail('asset manifest entry must contain a URL');
    let url;
    try { url = new URL(item.url); } catch { fail('asset URL is invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password) fail('asset URLs must use HTTPS without embedded credentials');
    if (!['files.catbox.moe', 'litter.catbox.moe'].includes(url.hostname) &&
        context.allowExternalAssetSharing !== true) {
      fail('external asset sharing requires explicit project approval');
    }
    if (item.verified !== true || typeof item.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 1) {
      fail('asset links require verified=true, a SHA-256 digest and a positive byte count');
    }
    return {
      url: url.toString(),
      sha256: item.sha256.toLowerCase(),
      bytes: item.bytes,
      verified: true,
      visibility: url.hostname === 'files.catbox.moe' || url.hostname === 'litter.catbox.moe' ? 'public' : 'unknown',
      ...(typeof item.purpose === 'string' ? {purpose: item.purpose.slice(0, 240)} : {})
    };
  });
}

function buildReviewPrompt({question, scene, intent, context = {}} = {}) {
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) {
    fail('review question must contain 1..4000 characters');
  }
  const assets = normalizeAssetLinks(context);
  const brief = {
    task: typeof intent?.goal === 'string' ? intent.goal.slice(0, 4000) : '',
    subsystem: typeof context.reviewSubsystem === 'string' ? context.reviewSubsystem : 'independent-review',
    question: question.trim(),
    scene: compactScene(scene),
    sourceAssets: assets,
    constraints: [
      'Use only evidence available in the source assets and the supplied Scene IR.',
      'Do not invent anatomy, layer identity, geometry, masks, visibility or parent relationships.',
      'Keep unknown values unknown and express uncertainty explicitly.',
      'Return JSON only: {"claims":[{"id":"...","subjectId":"...","predicate":"...","value":...,"confidence":0..1,"evidenceRefs":["..."]}]}',
      'Every subjectId and evidenceRef must match the supplied Scene IR.',
      'Do not claim that a model conclusion is deterministic verification.',
      'Asset delivery is URL-only: inspect source assets only through the supplied HTTPS links.',
      'Do not request file attachments, do not expect inline image payloads, and do not ask for base64 or pasted file contents.'
    ]
  };
  return 'You are one independent SA reviewer. Do not assume other reviewers exist and do not seek or reuse their answers. Analyze only this question and return the required JSON.\n' +
    JSON.stringify(brief);
}

function createChatGPTReviewers({driver, questions, maxReviewers = 8, timeoutMs = 90000} = {}) {
  if (!object(driver)) fail('a ChatGPT.com browser driver is required');
  for (const method of ['createConversation', 'selectModel', 'setReasoning', 'sendMessage', 'readResponse']) {
    if (typeof driver[method] !== 'function') fail('driver.' + method + '() is required');
  }
  if (!Number.isInteger(maxReviewers) || maxReviewers < 1 || maxReviewers > 8) {
    fail('maxReviewers must be between 1 and 8');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    fail('timeoutMs must be between 1000 and 300000');
  }
  if (driver.cancelConversation !== undefined && typeof driver.cancelConversation !== 'function') {
    fail('driver.cancelConversation must be a function when provided');
  }
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > maxReviewers) {
    fail('questions must contain 1..' + maxReviewers + ' independent questions');
  }
  const ids = new Set();
  for (const item of questions) {
    if (!object(item) || typeof item.id !== 'string' || !/^[a-z][a-z0-9._-]{1,63}$/.test(item.id) ||
        ids.has(item.id) || typeof item.question !== 'string' || !item.question.trim()) {
      fail('each question needs a unique safe id and non-empty question');
    }
    ids.add(item.id);
  }
  const sessions = new Set();
  return questions.map(item => ({
    id: 'chatgpt.review.' + item.id,
    provider: 'chatgpt.com.latest.reasoning',
    independenceGroup: 'chatgpt.session.' + item.id,
    model: 'latest',
    reasoning: true,
    run: async ({scene, intent, context = {}} = {}) => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let conversationId = null;
      let timer = null;
      const task = (async () => {
      const session = await driver.createConversation({
        mode: 'chatgpt.com',
        title: 'SA independent review ' + item.id,
        ...(controller ? {signal: controller.signal} : {})
      });
      conversationId = session && session.id;
      if (!object(session) || typeof session.id !== 'string' || !session.id.trim()) {
        fail('ChatGPT.com did not return a conversation ID');
      }
      if (sessions.has(session.id)) fail('reviewers must use distinct ChatGPT.com conversations');
      sessions.add(session.id);

      const selected = await driver.selectModel({conversationId: session.id, model: 'latest', ...(controller ? {signal: controller.signal} : {})});
      if (!object(selected) || selected.model !== 'latest') {
        fail('ChatGPT.com Latest model selection could not be verified');
      }
      const reasoning = await driver.setReasoning({conversationId: session.id, enabled: true, ...(controller ? {signal: controller.signal} : {})});
      if (!object(reasoning) || reasoning.enabled !== true) {
        fail('ChatGPT.com reasoning mode could not be verified as enabled');
      }
      const prompt = buildReviewPrompt({question: item.question, scene, intent, context});
      await driver.sendMessage({conversationId: session.id, text: prompt, ...(controller ? {signal: controller.signal} : {})});
      const response = await driver.readResponse({conversationId: session.id, ...(controller ? {signal: controller.signal} : {})});
      if (!object(response) || !Array.isArray(response.claims)) {
        fail('ChatGPT.com reviewer did not return structured claims');
      }
      return {
        claims: response.claims,
        session: {
          conversationId: session.id,
          mode: 'chatgpt.com',
          model: 'latest',
          reasoning: true
        }
      };
      })();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (controller) controller.abort();
          if (conversationId && typeof driver.cancelConversation === 'function') {
            Promise.resolve(driver.cancelConversation({conversationId, reason: 'review-timeout'})).catch(() => {});
          }
          reject(new Error('SA ChatGPT Review Adapter: reviewer timed out after ' + timeoutMs + ' ms'));
        }, timeoutMs);
      });
      try { return await Promise.race([task, timeout]); }
      finally { if (timer !== null) clearTimeout(timer); }
    }
  }));
}

const api = {createChatGPTReviewers, buildReviewPrompt, compactScene};
if (typeof module === 'object' && module.exports) module.exports = api;
else if (typeof globalThis !== 'undefined') globalThis.SAChatGPTReviewAdapter = api;
})();
