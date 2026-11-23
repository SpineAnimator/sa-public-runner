'use strict';

/*
 * Addressable A1-A7 command/event consumer for the SA Edge Runtime.
 * Queue durability is supplied by the transport; deduplication durability is
 * supplied by an atomic idempotencyStore. The included memory store is test-only.
 */
const Contract = require('./sa-edge-contract.js');
const ROLE_IDS = new Set(['A1','A2','A3','A4','A5','A6','A7']);

function fail(message) { throw new Error('SA Event Fabric: ' + message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function createMemoryIdempotencyStore() {
  const entries = new Map();
  return Object.freeze({
    async claim(key) {
      const current = entries.get(key);
      if (current?.status === 'completed') return { acquired: false, completed: true, receipt: current.receipt };
      if (current?.status === 'processing') return { acquired: false, inProgress: true };
      entries.set(key, { status: 'processing' });
      return { acquired: true };
    },
    async complete(key, receipt) { entries.set(key, { status: 'completed', receipt }); },
    async release(key) { if (entries.get(key)?.status === 'processing') entries.delete(key); },
    async get(key) { return entries.get(key) || null; }
  });
}

function createEventFabric({ transport, idempotencyStore, now = () => new Date(),
  retryDelaySeconds = 30 } = {}) {
  if (!transport || typeof transport.publish !== 'function' ||
      typeof transport.pull !== 'function' || typeof transport.ack !== 'function' ||
      typeof transport.retry !== 'function') fail('publish/pull/ack/retry transport is required');
  if (!idempotencyStore || typeof idempotencyStore.claim !== 'function' ||
      typeof idempotencyStore.complete !== 'function' ||
      typeof idempotencyStore.release !== 'function') {
    fail('an atomic idempotencyStore (claim/complete/release) is required');
  }
  if (!Number.isInteger(retryDelaySeconds) || retryDelaySeconds < 0 || retryDelaySeconds > 86400) fail('retryDelaySeconds is invalid');

  const roles = new Map();
  const subscriptions = new Map();

  function registerRole({ id, permissionScope = [], subscriptions: filters = [], handle } = {}) {
    if (!ROLE_IDS.has(id)) fail('role id must be A1..A7');
    if (roles.has(id)) fail('role already registered: ' + id);
    if (!Array.isArray(permissionScope) || permissionScope.some(x => typeof x !== 'string' || !x.trim())) {
      fail('permissionScope must be an array of non-empty strings');
    }
    if (!Array.isArray(filters) || filters.some(x => !object(x))) fail('subscriptions must be an array of filter objects');
    if (typeof handle !== 'function') fail('role handler is required');
    const role = Object.freeze({ id, permissionScope: new Set(permissionScope), handle });
    roles.set(id, role);
    subscriptions.set(id, filters.map(filter => Object.freeze({ ...filter })));
    return id;
  }

  function matches(filter, event) {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = key.split('.').reduce((value, part) => value == null ? undefined : value[part], event);
      return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
    });
  }

  function recipients(event) {
    const targetRole = String(event.target || '').split('.')[0];
    if (event.direction === 'command') {
      if (!targetRole) fail('commands must target an addressable A1-A7 role');
      return roles.has(targetRole) ? [roles.get(targetRole)] : [];
    }
    return [...roles.values()].filter(role =>
      (subscriptions.get(role.id) || []).some(filter => matches(filter, event)));
  }

  async function publish(event) {
    Contract.validateEnvelope(event);
    return transport.publish(event);
  }

  async function dispatch(event) {
    Contract.validateEnvelope(event);
    const targets = recipients(event);
    if (!targets.length) fail('no registered role subscribes to ' + event.target + ' / ' + event.kind);
    const outcomes = [];
    for (const role of targets) {
      const unauthorized = event.policy_context.permission_scope.filter(scope => !role.permissionScope.has(scope));
      let status = 'succeeded', result = null, errorText = null;
      if (unauthorized.length) {
        status = 'blocked';
        errorText = 'permission scope denied: ' + unauthorized.join(', ');
      } else {
        try {
          result = await role.handle(event, Object.freeze({
            roleId: role.id, now: now(), publish,
            correlationId: event.correlation_id, causationId: event.event_id
          }));
        } catch (error) {
          status = 'failed';
          errorText = String(error?.message || error).slice(0, 500);
        }
      }
      if (event.direction === 'command') {
        const feedback = Contract.createFeedback(event, {
          role_id: role.id, source: role.id + '.runtime', target: event.source,
          kind: status === 'succeeded' ? 'role.command.completed' : 'role.command.' + status,
          status,
          artifact_refs: Array.isArray(result?.artifact_refs) ? result.artifact_refs : [],
          evidence_refs: Array.isArray(result?.evidence_refs) ? result.evidence_refs : [],
          payload: status === 'succeeded'
            ? { result_summary: { type: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
                keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 32) : [] } }
            : { error: errorText },
          policy_context: event.policy_context
        });
        await publish(feedback);
      }
      outcomes.push({ roleId: role.id, status, ...(errorText ? { error: errorText } : {}),
        ...(status === 'succeeded' ? { result } : {}) });
    }
    return { eventId: event.event_id, correlationId: event.correlation_id, outcomes,
      status: outcomes.every(x => x.status === 'succeeded') ? 'succeeded' :
        outcomes.some(x => x.status === 'failed') ? 'failed' : 'blocked' };
  }

  async function consumeOnce({ batchSize = 10, visibilityTimeoutMs = 60000 } = {}) {
    const messages = await transport.pull({ batchSize, visibilityTimeoutMs });
    const summary = { pulled: messages.length, acknowledged: 0, retried: 0, completed: 0, blocked: 0, duplicates: 0, failed: 0 };
    for (const message of messages) {
      const lease = message?.lease_id;
      if (typeof lease !== 'string' || !lease) { summary.failed++; continue; }
      const event = message.body;
      let key = null;
      try {
        Contract.validateEnvelope(event);
        key = event.event_id;
        const claim = await idempotencyStore.claim(key);
        if (claim?.completed) {
          await transport.ack([lease]); summary.acknowledged++; summary.duplicates++; continue;
        }
        if (!claim?.acquired) {
          await transport.retry([lease], retryDelaySeconds); summary.retried++; continue;
        }
        const result = await dispatch(event);
        if (result.status === 'failed') {
          await idempotencyStore.release(key);
          // Cloudflare Queue's configured retry budget moves poison messages to
          // the configured DLQ. A failed side effect is never acknowledged.
          const attempts = Number.isInteger(message.attempts) ? message.attempts : 0;
          const delay = Math.min(retryDelaySeconds * Math.max(1, 2 ** Math.min(attempts, 10)), 86400);
          await transport.retry([lease], delay);
          summary.retried++; summary.failed++; continue;
        }
        const terminalStatus = result.status === 'blocked' ? 'blocked' : 'succeeded';
        await idempotencyStore.complete(key, { status: terminalStatus, correlationId: event.correlation_id });
        await transport.ack([lease]);
        summary.acknowledged++;
        if (terminalStatus === 'blocked') summary.blocked++;
        else summary.completed++;
      } catch (error) {
        if (key) await idempotencyStore.release(key);
        try { await transport.retry([lease], retryDelaySeconds); summary.retried++; }
        catch (_) { summary.failed++; }
        summary.failed++;
      }
    }
    return summary;
  }

  return Object.freeze({
    registerRole,
    publish,
    dispatch,
    consumeOnce,
    listRoles: () => [...roles.keys()],
    listSubscriptions: () => [...subscriptions.entries()].map(([roleId, filters]) => ({ roleId, filters }))
  });
}

module.exports = { createEventFabric, createMemoryIdempotencyStore };
