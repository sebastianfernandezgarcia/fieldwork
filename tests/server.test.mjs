import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { QlooProvider } from '../lib/qloo.mjs';

async function withServer(fn, options = {}) {
  const server = createApp({ env: {}, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, server); } finally { await new Promise(resolve => server.close(resolve)); }
}

const post = (base, route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('public live default advertises configuration without calling a provider', () => withServer(async base => {
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.defaultDataMode, 'live');
  assert.equal(health.qlooConfigured, true);
}, {
  env: { FIELDWORK_DEFAULT_MODE: 'live', QLOO_API_KEY: 'test-only-key' },
  providerFactory: () => { assert.fail('Health must not spend any quota'); },
}));

test('server ignores forged candidate/provenance data and enforces canonical revision', () => withServer(async base => {
  const created = await (await post(base, '/api/rehearse', { exampleId: 'quiet-city' })).json();
  const actualId = created.treatments[0].id;
  const forged = { ...created, dataMode: 'live', treatments: [{ id: actualId, candidate: { name: 'FORGED LOCATION' } }], provenance: { qlooUsed: true } };
  const response = await post(base, '/api/revise', { state: forged, action: { type: 'lock', targetId: actualId } });
  assert.equal(response.status, 200);
  const revised = await response.json();
  assert.equal(revised.dataMode, 'fixture');
  assert.equal(revised.provenance.qlooUsed, false);
  assert.notEqual(revised.treatments[0].candidate.name, 'FORGED LOCATION');
  const stale = await post(base, '/api/revise', { state: { runId: created.runId, revision: 1 }, action: { type: 'unlock', targetId: actualId } });
  assert.equal(stale.status, 409);
}));

test('missing live credentials fail explicitly and never return sample candidates', () => withServer(async base => {
  const result = await post(base, '/api/rehearse', { exampleId: 'quiet-city', dataMode: 'live' });
  assert.equal(result.status, 503);
  const body = await result.json();
  assert.equal(body.error.code, 'QLOO_NOT_CONFIGURED');
  assert.equal(body.candidates, undefined);
}));

test('state retrieval and JSON export retain the exact canonical revision', () => withServer(async base => {
  const state = await (await post(base, '/api/rehearse', { exampleId: 'slow-city' })).json();
  const exported = await (await fetch(`${base}/api/briefs/${state.runId}/export`)).json();
  assert.deepEqual(exported, state);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
}));

test('cross-origin actions and DNS rebinding Host headers are rejected', () => withServer(async (base, server) => {
  const cross = await post(base, '/api/rehearse', {}, { Origin: 'https://unrelated.example' });
  assert.equal(cross.status, 403);
  const crossSiteSearch = await fetch(base + '/api/search?domain=movie&dataMode=live&query=Paterson', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSiteSearch.status, 403);
  assert.equal((await crossSiteSearch.json()).error.code, 'ORIGIN');
  const rebind = await new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/api/health', headers: { Host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
  });
  assert.equal(rebind, 403);
}));

test('input limits reject large prompts and excess references before any provider call', () => withServer(async base => {
  const result = await post(base, '/api/rehearse', { brief: { city: 'Barcelona', references: Array.from({ length: 4 }, () => ({ query: 'Paterson', domain: 'movie' })) } });
  assert.equal(result.status, 400);
  const payload = await post(base, '/api/rehearse', { ignored: 'a'.repeat(170000) });
  assert.equal(payload.status, 413);
}));

test('canonical briefs survive a server restart in a private local session file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fieldwork-sessions-'));
  const sessionPath = path.join(directory, 'sessions.json');
  let state;
  try {
    await withServer(async base => { state = await (await post(base, '/api/rehearse', { exampleId: 'quiet-city' })).json(); }, { sessionPath });
    await withServer(async base => {
      const result = await post(base, '/api/revise', { state: { runId: state.runId, revision: state.revision }, action: { type: 'lock', targetId: state.treatments[0].id }, briefEdits: { title: 'Resumed after restart', note: 'Still here.' } });
      assert.equal(result.status, 200);
      const revised = await result.json();
      assert.equal(revised.revision, 2);
      assert.equal(revised.brief.title, 'Resumed after restart');
    }, { sessionPath });
    assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unresolved or stale fixed evidence cannot be exported as a current brief', () => withServer(async base => {
  let state = await (await post(base, '/api/rehearse', { exampleId: 'quiet-city' })).json();
  state = await (await post(base, '/api/revise', { state, action: { type: 'change-reference', referenceIndex: 0, reference: { query: 'Dune', domain: 'movie' } } })).json();
  const exported = await fetch(`${base}/api/briefs/${state.runId}/export`);
  assert.equal(exported.status, 409);
}));

test('HTTP searches share the external allowance across new provider instances', async () => {
  let upstreamCalls = 0;
  await withServer(async base => {
    const route = '/api/search?domain=movie&dataMode=live&query=';
    assert.equal((await fetch(base + route + 'Paterson')).status, 200);
    const blocked = await fetch(base + route + 'Perfect%20Days');
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, 'REQUEST_BUDGET_EXHAUSTED');
    assert.equal(upstreamCalls, 1);
  }, {
    env: { QLOO_API_KEY: 'test-only-key', FIELDWORK_QLOO_MAX_PER_DAY: '1' },
    providerFactory: (_mode, config) => new QlooProvider({ ...config, fetchImpl: async () => { upstreamCalls++; return Response.json({ results: [] }); } }),
  });
});

test('global capacity refuses a simultaneous scout and is released after an upstream failure', async () => {
  let entered;
  const firstEntered = new Promise(resolve => { entered = resolve; });
  let finishFirst;
  const firstGate = new Promise(resolve => { finishFirst = resolve; });
  let calls = 0;
  await withServer(async base => {
    const route = '/api/search?domain=movie&dataMode=live&query=Paterson';
    const first = fetch(base + route);
    try {
      await firstEntered;
      const second = await fetch(base + route);
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error.code, 'OPERATION_CAPACITY');
      assert.equal((await fetch(base + '/api/health')).status, 200);
    } finally { finishFirst(); }
    assert.equal((await first).status, 503);
    assert.equal((await fetch(base + route)).status, 200);
    assert.equal(calls, 2);
  }, {
    env: { QLOO_API_KEY: 'test-only-key', FIELDWORK_MAX_ACTIVE_OPERATIONS: '1' },
    providerFactory: (_mode, config) => new QlooProvider({ ...config, fetchImpl: async () => {
      if (++calls === 1) { entered(); await firstGate; throw new Error('private transport detail'); }
      return Response.json({ results: [] });
    } }),
  });
});

test('closing expensive-operation capacity keeps sample decisions and export usable', () => withServer(async base => {
  const created = await (await post(base, '/api/rehearse', { exampleId: 'quiet-city' })).json();
  const response = await post(base, '/api/revise', { state: created, action: { type: 'lock', targetId: created.treatments[0].id } });
  assert.equal(response.status, 200);
  const revised = await response.json();
  assert.equal(revised.treatments[0].locked, true);
  assert.equal((await fetch(`${base}/api/briefs/${created.runId}/export`)).status, 200);
  const live = await fetch(base + '/api/search?domain=movie&dataMode=live&query=Paterson');
  assert.equal(live.status, 429);
  assert.equal((await live.json()).error.code, 'OPERATION_CAPACITY');
}, { env: { FIELDWORK_MAX_ACTIVE_OPERATIONS: '0' } }));
