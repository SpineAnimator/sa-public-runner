const bearer = request => {
  const match = (request.headers.get('authorization') || '').match(/^Bearer ([A-Za-z0-9_.-]+)$/);
  return match ? match[1] : '';
};
const jsonResponse = (status, value) => Response.json(value, {
  status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer' }
});
const safeId = value => /^sa_[a-zA-Z0-9_-]{20,40}$/.test(value || '');

export function createJobHandoffHttpHandler({ jobHandoff, maxSourceBytes = 64 * 1024 * 1024 } = {}) {
  if (!jobHandoff || !['create', 'read', 'readSource', 'claim', 'complete'].every(name => typeof jobHandoff[name] === 'function'))
    throw new Error('A configured SA Job Handoff service is required');
  return async function handle(request) {
    const path = new URL(request.url).pathname;
    if (path !== '/api/jobs' && !path.startsWith('/api/jobs/')) return null;
    const token = bearer(request);
    try {
      if (path === '/api/jobs' && request.method === 'POST') {
        if (!token) return jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'Site session required' } });
        const declared = Number(request.headers.get('content-length') || 0);
        if (declared > maxSourceBytes + 1024 * 1024)
          return jsonResponse(413, { error: { code: 'SOURCE_SIZE', message: 'Source upload exceeds the configured limit' } });
        if (!/^multipart\/form-data(?:;|$)/i.test(request.headers.get('content-type') || ''))
          return jsonResponse(415, { error: { code: 'CONTENT_TYPE', message: 'Multipart form data is required' } });
        const form = await request.formData();
        const file = form.get('file');
        if (!file || typeof file.arrayBuffer !== 'function' || typeof file.size !== 'number')
          return jsonResponse(400, { error: { code: 'SOURCE_FILE', message: 'A PSD/PSB file field is required' } });
        if (file.size < 26 || file.size > maxSourceBytes)
          return jsonResponse(413, { error: { code: 'SOURCE_SIZE', message: 'PSD/PSB file is empty or too large' } });
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length !== file.size) return jsonResponse(400, { error: { code: 'SOURCE_SIZE', message: 'Source byte count changed during upload' } });
        const created = await jobHandoff.create({ sessionToken: token, fileName: file.name,
          bytes, intent: String(form.get('intent') || '') });
        return jsonResponse(201, created);
      }
      if (path === '/api/jobs') return jsonResponse(405, { error: { code: 'METHOD', message: 'Method not allowed' } });
      const match = path.match(/^\/api\/jobs\/(sa_[A-Za-z0-9_-]{20,40})(?:\/(source|claim|complete))?$/);
      if (!match) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Job unavailable' } });
      const [, projectId, action] = match;
      if (!safeId(projectId)) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Job unavailable' } });
      if (request.method === 'GET' && !action) {
        const job = await jobHandoff.read({ token });
        if (job.projectId !== projectId) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Job unavailable' } });
        return jsonResponse(200, job);
      }
      if (request.method === 'GET' && action === 'source') {
        const source = await jobHandoff.readSource({ token });
        const job = await jobHandoff.read({ token });
        if (job.projectId !== projectId) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Source unavailable' } });
        return new Response(source.bytes, { status: 200, headers: {
          'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
          'content-type': source.mime, 'content-length': String(source.bytes.byteLength),
          'content-disposition': 'attachment; filename="' + source.fileName.replace(/["\\\r\n]/g, '_') + '"'
        } });
      }
      if (request.method === 'POST' && (action === 'claim' || action === 'complete')) {
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || ''))
          return jsonResponse(415, { error: { code: 'CONTENT_TYPE', message: 'JSON request body required' } });
        const body = await request.json();
        const result = action === 'claim'
          ? await jobHandoff.claim({ token, expectedRevision: body.expectedRevision })
          : await jobHandoff.complete({ token, expectedRevision: body.expectedRevision, result: body.result });
        if (result.projectId !== projectId) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Job unavailable' } });
        return jsonResponse(200, result);
      }
      return jsonResponse(405, { error: { code: 'METHOD', message: 'Method not allowed' } });
    } catch (error) {
      return jsonResponse(Number.isInteger(error?.status) ? error.status : 502, {
        error: { code: typeof error?.code === 'string' ? error.code : 'JOB_HANDOFF_FAILURE',
          message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'Job handoff failed' }
      });
    }
  };
}
