import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError, publicError } from './lib/errors.mjs';
import { rehearse, revise, providerFor } from './lib/engine.mjs';
import { EXAMPLES } from './lib/fixtures.mjs';
import { validateMode, validateReference } from './lib/validation.mjs';
import { createPolicyPlanner, createOllamaPlanner, createGroqPlanner, DEFAULT_GROQ_MODEL } from './lib/planner.mjs';
import { createSessionPersistence } from './lib/session-store.mjs';
import { createRequestBudget } from './lib/request-budget.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };

async function readBody(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new AppError('CONTENT_TYPE', 'Send JSON for this action.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 160_000) throw new AppError('BODY_TOO_LARGE', 'This brief is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('VALIDATION', 'Send a valid JSON brief.'); }
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function createApp({ env = process.env, providerFactory, plannerFactory, plannerBeforeRequest, now = () => Date.now(), maxSessions = 120, sessionPath = null } = {}) {
  const sessions = new Map();
  const persistence = createSessionPersistence(sessionPath, sessions, { now, maxSessions });
  // The handler reports a storage failure safely rather than an unhandled startup rejection.
  persistence.ready.catch(() => {});
  const busy = new Set();
  const limits = new Map();
  const budget = createRequestBudget({ env, now });
  const makeProvider = mode => (providerFactory ?? providerFor)(mode, {
    apiKey: env.QLOO_API_KEY,
    baseUrl: env.QLOO_API_BASE_URL ?? 'https://api.qloo.com',
    beforeRequest: budget.reserve,
  });
  function reservePlannerRequest(request) {
    // Optional instrumentation can reject first; a rejected hook consumes no
    // provider reservation. The built-in quota cannot be bypassed by a hook.
    plannerBeforeRequest?.(request);
    budget.reserve(request);
  }
  async function withCapacity(expensive, operation) {
    const release = expensive ? budget.acquire() : () => {};
    try { return await operation(); } finally { release(); }
  }
  const usesModel = ['groq', 'ollama'].includes(env.FIELDWORK_PLANNER);
  function plannerConfiguration() {
    const mode = env.FIELDWORK_PLANNER || 'policy';
    if (mode === 'policy') return { name: 'bounded-policy-v1', model: null, configured: true };
    if (mode === 'ollama') return { name: 'local-ollama', model: env.OLLAMA_MODEL || 'qwen3-vl:8b', configured: true };
    if (mode === 'groq' && (!env.GROQ_MODEL || env.GROQ_MODEL === DEFAULT_GROQ_MODEL)) return { name: 'groq', model: DEFAULT_GROQ_MODEL, configured: Boolean(env.GROQ_API_KEY) };
    throw new AppError('PLANNER_CONFIGURATION', 'Choose a supported FIELDWORK planner and model in the server configuration.', 503);
  }
  const makePlanner = plannerFactory ?? (() => {
    const config = plannerConfiguration();
    if (config.name === 'local-ollama') return createOllamaPlanner({ model: config.model });
    if (config.name === 'groq') return createGroqPlanner({ apiKey: env.GROQ_API_KEY, model: config.model, beforeRequest: reservePlannerRequest });
    return createPolicyPlanner();
  });

  function clean() {
    const instant = now();
    for (const [id, item] of sessions) if (instant - item.touched > persistence.ttlMs && !busy.has(id)) sessions.delete(id);
    for (const [key, item] of limits) if (instant - item.since > 60_000) limits.delete(key);
    while (sessions.size > maxSessions) {
      const oldest = [...sessions.keys()].find(key => !busy.has(key));
      if (!oldest) break;
      sessions.delete(oldest);
    }
  }

  function rateLimit(req, mode) {
    const key = `${req.socket.remoteAddress}:${mode}`;
    const limit = mode === 'live' ? 6 : 40;
    const item = limits.get(key) ?? { since: now(), count: 0 };
    item.count++;
    limits.set(key, item);
    if (item.count > limit) throw new AppError('RATE_LIMIT', 'Too many requests. Please wait a minute before another scout.', 429);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    // Local self-contained UI. External entity images remain subject to their own display rights.
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; media-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const host = req.headers.host;
      let publicOrigin;
      try { publicOrigin = env.FIELDWORK_PUBLIC_ORIGIN ? new URL(env.FIELDWORK_PUBLIC_ORIGIN) : null; } catch { throw new AppError('CONFIGURATION', 'The public origin configuration is invalid.', 503); }
      let requestBase;
      try { requestBase = new URL(`http://${host}`); } catch { throw new AppError('HOST', 'This host is not enabled for FIELDWORK.', 403); }
      const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(requestBase.hostname);
      if (!host || (!isLocal && requestBase.host !== publicOrigin?.host)) throw new AppError('HOST', 'This host is not enabled for FIELDWORK.', 403);
      const origin = isLocal ? requestBase.origin : publicOrigin.origin;
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('ORIGIN', 'Use the FIELDWORK application to request this data.', 403);
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== url.origin) throw new AppError('ORIGIN', 'Use the FIELDWORK application to submit a brief.', 403);
      await persistence.ready;
      clean();
      if (url.pathname === '/api/health' && req.method === 'GET') {
        const planner = plannerConfiguration();
        const defaultDataMode = env.FIELDWORK_DEFAULT_MODE || 'fixture';
        if (!['fixture', 'live'].includes(defaultDataMode)) throw new AppError('CONFIGURATION', 'The default data mode must be sample or live.', 503);
        return send(res, 200, { ok: true, defaultDataMode, qlooConfigured: Boolean(env.QLOO_API_KEY), planner: planner.name, plannerConfigured: planner.configured, model: planner.model, version: '0.1.0' });
      }
      if (url.pathname === '/api/examples' && req.method === 'GET') return send(res, 200, { examples: EXAMPLES });
      if (url.pathname === '/api/search' && req.method === 'GET') {
        const dataMode = validateMode(url.searchParams.get('dataMode') || 'fixture');
        const reference = validateReference({ query: url.searchParams.get('query'), domain: url.searchParams.get('domain') || 'movie' });
        rateLimit(req, dataMode);
        const candidates = await withCapacity(dataMode === 'live', () => makeProvider(dataMode).search(reference.query, reference.domain));
        return send(res, 200, { status: candidates.length ? 'ok' : 'needs_input', dataMode, candidates });
      }
      if (url.pathname === '/api/rehearse' && req.method === 'POST') {
        const input = await readBody(req);
        const dataMode = validateMode(input?.dataMode);
        rateLimit(req, dataMode);
        const state = await withCapacity(dataMode === 'live' || usesModel, () => rehearse(input, { provider: makeProvider(dataMode), planner: makePlanner() }));
        sessions.set(state.runId, { state: structuredClone(state), touched: now() });
        clean();
        try { await persistence.save(); }
        catch (error) { sessions.delete(state.runId); throw error; }
        return send(res, 200, state);
      }
      if (url.pathname === '/api/revise' && req.method === 'POST') {
        const input = await readBody(req);
        const runId = input?.state?.runId;
        const session = sessions.get(runId);
        if (!session) throw new AppError('SESSION_EXPIRED', 'This brief is no longer in the server session. Open the sample or scout again.', 404);
        if (input.state.revision !== session.state.revision) throw new AppError('STALE_REVISION', 'A newer revision exists. Reload the latest brief before changing it.', 409);
        if (busy.has(runId)) throw new AppError('REVISION_BUSY', 'This brief is already being revised. Wait for that revision to finish.', 409);
        rateLimit(req, session.state.dataMode);
        busy.add(runId);
        try {
          // Only the canonical server state is trusted. Client candidate data is ignored.
          const needsProvider = !['lock', 'unlock'].includes(input?.action?.type);
          const state = await withCapacity(needsProvider && (session.state.dataMode === 'live' || usesModel), () => revise(session.state, input.action, { provider: needsProvider ? makeProvider(session.state.dataMode) : undefined, planner: needsProvider ? makePlanner() : createPolicyPlanner(), briefEdits: input.briefEdits }));
          sessions.set(runId, { state: structuredClone(state), touched: now() });
          try { await persistence.save(); }
          catch (error) { sessions.set(runId, session); throw error; }
          return send(res, 200, state);
        } finally { busy.delete(runId); }
      }
      const exportMatch = url.pathname.match(/^\/api\/briefs\/([a-f0-9-]+)\/export$/);
      if (exportMatch && req.method === 'GET') {
        const session = sessions.get(exportMatch[1]);
        if (!session) throw new AppError('SESSION_EXPIRED', 'The brief is no longer in the server session.', 404);
        if (session.state.status !== 'ready' || session.state.treatments.some(t => t.needsReview)) throw new AppError('BRIEF_NEEDS_REVIEW', 'Resolve the references and review fixed treatments before exporting this brief.', 409);
        res.setHeader('Content-Disposition', `attachment; filename="fieldwork-brief-r${session.state.revision}.json"`);
        return send(res, 200, session.state);
      }
      const runMatch = url.pathname.match(/^\/api\/briefs\/([a-f0-9-]+)$/);
      if (runMatch && req.method === 'GET') {
        const session = sessions.get(runMatch[1]);
        if (!session) throw new AppError('SESSION_EXPIRED', 'The brief is no longer in the server session.', 404);
        return send(res, 200, session.state);
      }
      if (url.pathname.startsWith('/api/')) throw new AppError('NOT_FOUND', 'That API route does not exist.', 404);
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError('METHOD', 'That method is not supported.', 405);
      let requested;
      try { requested = decodeURIComponent(url.pathname); } catch { throw new AppError('NOT_FOUND', 'File not found.', 404); }
      const file = path.resolve(PUBLIC, requested === '/' ? 'index.html' : `.${requested}`);
      if (!file.startsWith(PUBLIC + path.sep)) throw new AppError('NOT_FOUND', 'File not found.', 404);
      let info;
      try { info = await stat(file); } catch { throw new AppError('NOT_FOUND', 'File not found.', 404); }
      if (!info.isFile()) throw new AppError('NOT_FOUND', 'File not found.', 404);
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const safe = publicError(error);
      if (!res.headersSent) send(res, safe.status, safe.body);
      else res.end();
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4322);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const sessionPath = process.env.FIELDWORK_SESSION_FILE || path.join(ROOT, '.local', 'sessions.json');
  createApp({ sessionPath }).listen(port, host, () => console.log(`FIELDWORK ready at http://${host}:${port} · default sample data`));
}
