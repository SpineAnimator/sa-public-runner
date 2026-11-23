'use strict';

/**
 * Transport-neutral, bidirectional event contract for Spine Animation Agent.
 * This module validates envelopes; it does not claim to provide durable delivery.
 */
const SCHEMA = 'sa.edge-event.v1';
const ROLES = Object.freeze(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'EDGE']);
const DIRECTIONS = Object.freeze(['command', 'event', 'result', 'feedback']);
const STATUSES = Object.freeze([
  'requested', 'accepted', 'running', 'succeeded', 'failed', 'blocked', 'timed_out'
]);
const CLASSIFICATIONS = Object.freeze(['public', 'project-private', 'restricted']);
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(message) {
  throw new TypeError('SA edge contract: ' + message);
}
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonEmpty(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(name + ' must be a non-empty string of at most ' + max + ' characters');
  }
  return value;
}
function date(value, name) {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(name + ' must be an ISO-8601 timestamp with timezone');
  }
}
function validateArtifactRefs(refs) {
  if (!Array.isArray(refs)) fail('artifact_refs must be an array');
  for (const [index, ref] of refs.entries()) {
    if (!isObject(ref)) fail('artifact_refs[' + index + '] must be an object');
    nonEmpty(ref.uri, 'artifact_refs[' + index + '].uri', 2048);
    if (!SHA256.test(ref.sha256 || '')) fail('artifact_refs[' + index + '].sha256 must be lowercase SHA-256');
    if (ref.media_type !== undefined && typeof ref.media_type !== 'string') {
      fail('artifact_refs[' + index + '].media_type must be a string');
    }
  }
}
function validateEnvelope(event, options = {}) {
  if (!isObject(event)) fail('event must be an object');
  if (event.schema !== SCHEMA) fail('unsupported schema');
  nonEmpty(event.event_id, 'event_id');
  nonEmpty(event.correlation_id, 'correlation_id');
  if (event.causation_id !== null && event.causation_id !== undefined) {
    nonEmpty(event.causation_id, 'causation_id');
  }
  nonEmpty(event.project_id, 'project_id');
  nonEmpty(event.work_item_id, 'work_item_id');
  if (!ROLES.includes(event.role_id)) fail('role_id is not recognized');
  nonEmpty(event.source, 'source');
  nonEmpty(event.target, 'target');
  if (!DIRECTIONS.includes(event.direction)) fail('direction is not recognized');
  nonEmpty(event.kind, 'kind');
  if (event.input_sha256 !== undefined && event.input_sha256 !== null &&
      !SHA256.test(event.input_sha256)) fail('input_sha256 must be lowercase SHA-256');
  validateArtifactRefs(event.artifact_refs);
  if (!isObject(event.payload)) fail('payload must be an object');
  if (event.confidence !== null && event.confidence !== undefined &&
      (typeof event.confidence !== 'number' || !Number.isFinite(event.confidence) ||
       event.confidence < 0 || event.confidence > 1)) fail('confidence must be between 0 and 1');
  if (!STATUSES.includes(event.status)) fail('status is not recognized');
  if (!Array.isArray(event.evidence_refs)) fail('evidence_refs must be an array');
  for (const ref of event.evidence_refs) nonEmpty(ref, 'evidence_refs item', 2048);
  date(event.created_at, 'created_at');
  if (!isObject(event.policy_context)) fail('policy_context must be an object');
  if (!Array.isArray(event.policy_context.permission_scope) ||
      event.policy_context.permission_scope.some(x => typeof x !== 'string' || !x.trim())) {
    fail('policy_context.permission_scope must be an array of non-empty strings');
  }
  if (!CLASSIFICATIONS.includes(event.policy_context.data_classification)) {
    fail('policy_context.data_classification is not recognized');
  }
  date(event.policy_context.expires_at, 'policy_context.expires_at');
  if (Date.parse(event.policy_context.expires_at) <= Date.parse(event.created_at)) {
    fail('policy_context.expires_at must be later than created_at');
  }
  if (options.requireCommandTarget && event.direction !== 'command') {
    fail('a command envelope is required');
  }
  return true;
}

function createEnvelope(input, options = {}) {
  if (!isObject(input)) fail('input must be an object');
  const now = options.now || (() => new Date());
  const idFactory = options.idFactory || (() => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'sa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  });
  const createdAt = input.created_at || now().toISOString();
  const event = {
    schema: SCHEMA,
    event_id: input.event_id || idFactory(),
    correlation_id: input.correlation_id,
    causation_id: input.causation_id ?? null,
    project_id: input.project_id,
    work_item_id: input.work_item_id,
    role_id: input.role_id,
    source: input.source,
    target: input.target,
    direction: input.direction,
    kind: input.kind,
    ...(input.input_sha256 ? { input_sha256: input.input_sha256 } : {}),
    artifact_refs: input.artifact_refs || [],
    payload: input.payload || {},
    confidence: input.confidence ?? null,
    status: input.status || (input.direction === 'command' ? 'requested' : 'accepted'),
    evidence_refs: input.evidence_refs || [],
    created_at: createdAt,
    policy_context: {
      permission_scope: input.policy_context?.permission_scope || [],
      data_classification: input.policy_context?.data_classification || 'project-private',
      expires_at: input.policy_context?.expires_at ||
        new Date(Date.parse(createdAt) + 15 * 60 * 1000).toISOString()
    }
  };
  validateEnvelope(event);
  return Object.freeze({
    ...event,
    artifact_refs: Object.freeze(event.artifact_refs.map(ref => Object.freeze({ ...ref }))),
    payload: Object.freeze({ ...event.payload }),
    evidence_refs: Object.freeze([...event.evidence_refs]),
    policy_context: Object.freeze({
      ...event.policy_context,
      permission_scope: Object.freeze([...event.policy_context.permission_scope])
    })
  });
}

/** Construct the correlated return message for an accepted command. */
function createFeedback(command, input, options = {}) {
  validateEnvelope(command, { requireCommandTarget: true });
  if (!isObject(input)) fail('feedback input must be an object');
  for (const [key, expected] of Object.entries({
    correlation_id: command.correlation_id,
    causation_id: command.event_id,
    project_id: command.project_id,
    work_item_id: command.work_item_id
  })) {
    if (input[key] !== undefined && input[key] !== expected) {
      fail('feedback ' + key + ' must preserve command correlation and causation');
    }
  }
  const feedback = createEnvelope({
    ...input,
    correlation_id: command.correlation_id,
    causation_id: command.event_id,
    project_id: command.project_id,
    work_item_id: command.work_item_id,
    source: input.source || command.target,
    target: input.target || command.source,
    direction: input.direction || 'feedback'
  }, options);
  if (feedback.correlation_id !== command.correlation_id ||
      feedback.causation_id !== command.event_id ||
      feedback.project_id !== command.project_id ||
      feedback.work_item_id !== command.work_item_id) {
    fail('feedback must preserve command correlation and causation');
  }
  return feedback;
}

module.exports = {
  SCHEMA, ROLES, DIRECTIONS, STATUSES, CLASSIFICATIONS,
  validateEnvelope, createEnvelope, createFeedback
};
