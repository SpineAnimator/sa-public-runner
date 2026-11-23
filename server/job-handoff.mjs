import { webcrypto as nodeCrypto } from 'node:crypto';

const cryptoApi = globalThis.crypto || nodeCrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fail = (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; };
const safeProjectId = value => typeof value === 'string' && /^sa_[a-zA-Z0-9_-]{20,40}$/.test(value);
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const b64url = bytes => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};
const fromB64url = value => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};
const randomId = () => 'sa_' + b64url(cryptoApi.getRandomValues(new Uint8Array(18)));
const digest = async bytes => hex(await cryptoApi.subtle.digest('SHA-256', bytes));

function validSource(bytes, fileName, maxBytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 26 || bytes.byteLength > maxBytes)
    fail(413, 'SOURCE_SIZE', 'Source PSD/PSB is empty or exceeds the configured limit');
  if (typeof fileName !== 'string' || !/^[a-zA-Z0-9._-]{1,120}\.(psd|psb)$/i.test(fileName))
    fail(415, 'SOURCE_NAME', 'Only named PSD/PSB source files are accepted');
  if (bytes[0] !== 0x38 || bytes[1] !== 0x42 || bytes[2] !== 0x50 || bytes[3] !== 0x53)
    fail(415, 'SOURCE_SIGNATURE', 'PSD/PSB signature is invalid');
  const version = (bytes[4] << 8) | bytes[5];
  if (version !== 1 && version !== 2) fail(415, 'SOURCE_VERSION', 'Only PSD v1 and PSB v2 are accepted');
  return version === 2 ? 'image/vnd.adobe.photoshop' : 'image/vnd.adobe.photoshop';
}

export function createJobHandoff({
  store, secret, resolveSession, authorizeAgent, now = () => Date.now(),
  maxSourceBytes = 64 * 1024 * 1024, tokenLifetimeSeconds = 900, leaseSeconds = 300
} = {}) {
  if (!store || !['createJob', 'getJob', 'getSource', 'claimJob', 'completeJob'].every(method => typeof store[method] === 'function'))
    throw new Error('SA Job Handoff requires a private atomic job store');
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SA Job Handoff requires a server-only HMAC secret');
  if (typeof resolveSession !== 'function') throw new Error('SA Job Handoff requires a trusted server session resolver');
  if (typeof authorizeAgent !== 'function') throw new Error('SA Job Handoff requires an agent authorization resolver');
  if (!Number.isInteger(maxSourceBytes) || maxSourceBytes < 1 || maxSourceBytes > 128 * 1024 * 1024)
    throw new Error('Invalid source byte limit');
  if (!Number.isInteger(tokenLifetimeSeconds) || tokenLifetimeSeconds < 60 || tokenLifetimeSeconds > 3600)
    throw new Error('Invalid handoff token lifetime');
  const keyPromise = cryptoApi.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const issue = async payload => {
    const body = b64url(encoder.encode(JSON.stringify(payload)));
    const signature = new Uint8Array(await cryptoApi.subtle.sign('HMAC', await keyPromise, encoder.encode(body)));
    return body + '.' + b64url(signature);
  };
  const verify = async (token, requiredScope) => {
    try {
      if (typeof token !== 'string' || token.length > 4096) return null;
      const [body, signature, extra] = token.split('.');
      if (!body || !signature || extra) return null;
      const valid = await cryptoApi.subtle.verify('HMAC', await keyPromise, fromB64url(signature), encoder.encode(body));
      if (!valid) return null;
      const payload = JSON.parse(decoder.decode(fromB64url(body)));
      const timestamp = Math.floor(now() / 1000);
      if (payload.aud !== 'sa-job-handoff' || !safeProjectId(payload.projectId) ||
          !Number.isFinite(payload.exp) || payload.exp <= timestamp ||
          !Number.isFinite(payload.iat) || payload.iat > timestamp + 30 ||
          !Array.isArray(payload.scopes) || !payload.scopes.includes(requiredScope)) return null;
      return payload;
    } catch { return null; }
  };
  const tokenFor = async (projectId, subject, agentId, scopes) => {
    const timestamp = Math.floor(now() / 1000);
    return issue({ aud: 'sa-job-handoff', projectId, subject, agentId: agentId || null,
      scopes, iat: timestamp, exp: timestamp + tokenLifetimeSeconds,
      jti: b64url(cryptoApi.getRandomValues(new Uint8Array(16))) });
  };
  async function create({ sessionToken, fileName, bytes, intent = '' } = {}) {
    const session = await resolveSession(sessionToken);
    if (!session || typeof session.subject !== 'string' || !session.subject.trim())
      fail(401, 'AUTH_REQUIRED', 'A verified site session is required');
    const mime = validSource(bytes, fileName, maxSourceBytes);
    const sourceSha256 = await digest(bytes);
    const projectId = randomId();
    const stamp = now();
    const record = { projectId, ownerSubject: session.subject, status: 'queued', revision: 1,
      source: { fileName, mime, bytes: bytes.byteLength, sha256: sourceSha256 },
      intent: typeof intent === 'string' ? intent.slice(0, 4000) : '',
      createdAt: new Date(stamp).toISOString(), updatedAt: new Date(stamp).toISOString(),
      lease: null, result: null };
    await store.createJob(record, bytes);
    const ownerToken = await tokenFor(projectId, session.subject, null, ['job:read', 'job:source:read']);
    return Object.freeze({ projectId, status: 'queued', revision: 1, sourceSha256,
      bytes: bytes.byteLength, token: ownerToken, tokenExpiresIn: tokenLifetimeSeconds });
  }
  async function issueAgentToken({ projectId, agentId, scopes = ['job:read', 'job:source:read', 'job:claim', 'job:complete'] } = {}) {
    if (!safeProjectId(projectId) || typeof agentId !== 'string' || !agentId.trim() ||
        !Array.isArray(scopes) || !scopes.length || scopes.some(scope =>
          !['job:read', 'job:source:read', 'job:claim', 'job:complete'].includes(scope)))
      fail(400, 'AGENT_TOKEN', 'A valid project, agent and bounded scopes are required');
    const job = await store.getJob(projectId);
    if (!job) fail(404, 'JOB_NOT_FOUND', 'Project job is unavailable');
    if (await authorizeAgent({ agentId, projectId, job }) !== true)
      fail(403, 'AGENT_FORBIDDEN', 'Agent is not authorized for this project');
    return tokenFor(projectId, 'agent:' + agentId, agentId, [...new Set(scopes)]);
  }
  async function verifyAgentToken({ token, projectId, requiredScopes = [] } = {}) {
    if (!safeProjectId(projectId) || !Array.isArray(requiredScopes) ||
        requiredScopes.some(scope => !['job:read', 'job:source:read', 'job:claim', 'job:complete'].includes(scope)))
      fail(400, 'AGENT_TOKEN_SCOPE', 'A valid project and bounded required scopes are required');
    const claims = await verify(token, 'job:read');
    if (!claims || claims.projectId !== projectId || !claims.agentId ||
        requiredScopes.some(scope => !claims.scopes.includes(scope)))
      fail(401, 'AGENT_TOKEN_INVALID', 'A valid agent token with the required project scopes is required');
    const job = await store.getJob(projectId);
    if (!job || await authorizeAgent({ agentId: claims.agentId, projectId, job }) !== true)
      fail(403, 'AGENT_FORBIDDEN', 'Agent is no longer authorized for this project');
    return Object.freeze({ projectId, agentId: claims.agentId, scopes: [...claims.scopes] });
  }
  async function read({ token } = {}) {
    const claims = await verify(token, 'job:read');
    if (!claims) fail(401, 'TOKEN_INVALID', 'A valid scoped job token is required');
    const job = await store.getJob(claims.projectId);
    if (!job || (claims.agentId === null && claims.subject !== job.ownerSubject))
      fail(404, 'JOB_NOT_FOUND', 'Project job is unavailable');
    const { ownerSubject, ...safe } = job;
    return safe;
  }
  async function readSource({ token } = {}) {
    const claims = await verify(token, 'job:source:read');
    if (!claims) fail(401, 'TOKEN_INVALID', 'A valid source-read token is required');
    const job = await store.getJob(claims.projectId);
    if (!job || (claims.agentId === null && claims.subject !== job.ownerSubject))
      fail(404, 'JOB_NOT_FOUND', 'Project source is unavailable');
    const bytes = await store.getSource(claims.projectId);
    if (!(bytes instanceof Uint8Array) || await digest(bytes) !== job.source.sha256)
      fail(503, 'SOURCE_INTEGRITY', 'Private source object failed SHA-256 verification');
    return { bytes, fileName: job.source.fileName, mime: job.source.mime, sha256: job.source.sha256 };
  }
  async function claim({ token, expectedRevision } = {}) {
    const claims = await verify(token, 'job:claim');
    if (!claims || !claims.agentId) fail(401, 'TOKEN_INVALID', 'An authorized agent claim token is required');
    const stamp = now();
    const lease = { agentId: claims.agentId, leaseId: b64url(cryptoApi.getRandomValues(new Uint8Array(16))),
      expiresAt: new Date(stamp + leaseSeconds * 1000).toISOString() };
    const result = await store.claimJob(claims.projectId, expectedRevision, lease);
    if (!result || result.claimed !== true) fail(409, 'JOB_CLAIMED', 'Job revision changed or another agent owns the active lease');
    return result.job;
  }
  async function complete({ token, expectedRevision, result } = {}) {
    const claims = await verify(token, 'job:complete');
    if (!claims || !claims.agentId) fail(401, 'TOKEN_INVALID', 'An authorized agent completion token is required');
    if (!result || typeof result !== 'object' || result.sourceSha256 === undefined ||
        !/^[a-f0-9]{64}$/i.test(result.sourceSha256) || result.status !== 'ready' ||
        !Array.isArray(result.artifacts) || result.artifacts.length < 1 || result.artifacts.length > 100)
      fail(400, 'JOB_RESULT', 'A bounded, source-bound ready result manifest is required');
    const artifactNames = new Set();
    for (const artifact of result.artifacts) {
      if (!artifact || typeof artifact.name !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(artifact.name) ||
          artifactNames.has(artifact.name) || !/^[a-f0-9]{64}$/i.test(artifact.sha256 || '') ||
          !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > maxSourceBytes)
        fail(400, 'JOB_ARTIFACT', 'Every artifact requires a unique safe name, SHA-256 and bounded byte count');
      artifactNames.add(artifact.name);
    }
    const job = await store.getJob(claims.projectId);
    if (!job || result.sourceSha256.toLowerCase() !== job.source.sha256)
      fail(409, 'SOURCE_MISMATCH', 'Agent result does not match the project source SHA-256');
    const completed = await store.completeJob(claims.projectId, expectedRevision, claims.agentId, result);
    if (!completed || completed.updated !== true) fail(409, 'JOB_REVISION', 'Job lease or revision is no longer current');
    return completed.job;
  }
  return Object.freeze({ create, issueAgentToken, verifyAgentToken, read, readSource, claim, complete });
}
