/**
 * Cloudflare Worker entry for the archive API.
 * Manifest health remains read-only; asset writes require a signed session.
 */
import { createArchiveHandler } from '../../server/archive-handler.mjs';

const parse = value => {
  try { return value ? JSON.parse(value) : null; }
  catch { return null; }
};

async function manifestHealth(env) {
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
  if (!env.ARCHIVE) {
    return Response.json({
      service: '3spine-archive',
      status: 'not-ready',
      storage: 'workers-kv',
      format: 'private-ref-manifest',
      branchSnapshotCount: 0,
      archivePayloads: 'missing',
      archivedWorkerCount: 0,
      publicWrite: false,
      assetUpload: !!env.SESSION_SECRET,
      privateArchive: !!(env.GITHUB_LIBRARY_TOKEN && env.SESSION_SECRET && env.GENERATION_REPOSITORY)
    }, { status: 503, headers });
  }
  try {
    const [marker, branchRaw, payloadRaw] = await Promise.all([
      env.ARCHIVE.get('system/health'),
      env.ARCHIVE.get('snapshots/2026-11-12-branches.json'),
      env.ARCHIVE.get('system/archive-payloads-status')
    ]);
    const branchSnapshot = parse(branchRaw) || {};
    const payloadStatus = parse(payloadRaw) || {};
    const branchSnapshotCount = Array.isArray(branchSnapshot.branches) ? branchSnapshot.branches.length : 0;
    const archivedWorkerCount = Number.isInteger(payloadStatus.count) ? payloadStatus.count : 0;
    const ready = marker === 'ready' &&
      branchSnapshotCount > 0 &&
      payloadStatus.status === 'uploaded' &&
      archivedWorkerCount > 0;
    return Response.json({
      service: '3spine-archive',
      status: ready ? 'ready' : 'manifest-ready',
      storage: 'workers-kv',
      format: 'private-ref-manifest',
      branchSnapshotCount,
      archivePayloads: payloadStatus.status || 'missing',
      archivedWorkerCount,
      publicWrite: false,
      assetUpload: !!env.SESSION_SECRET,
      privateArchive: !!(env.GITHUB_LIBRARY_TOKEN && env.SESSION_SECRET && env.GENERATION_REPOSITORY)
    }, { status: ready ? 200 : 503, headers });
  } catch {
    return Response.json({
      service: '3spine-archive',
      status: 'not-ready',
      storage: 'workers-kv',
      format: 'private-ref-manifest',
      branchSnapshotCount: 0,
      archivePayloads: 'unavailable',
      archivedWorkerCount: 0,
      publicWrite: false,
      assetUpload: !!env.SESSION_SECRET,
      privateArchive: !!(env.GITHUB_LIBRARY_TOKEN && env.SESSION_SECRET && env.GENERATION_REPOSITORY)
    }, { status: 503, headers });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return manifestHealth(env);
    }
    const handler = createArchiveHandler(env);
    return handler(request);
  }
};
