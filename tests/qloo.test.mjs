import test from 'node:test';
import assert from 'node:assert/strict';
import { QlooProvider } from '../lib/qloo.mjs';
import { publicError } from '../lib/errors.mjs';
import { createRequestBudget } from '../lib/request-budget.mjs';

test('live mode requires its own server credential and rejects arbitrary credential destinations', () => {
  assert.throws(() => new QlooProvider(), { code: 'QLOO_NOT_CONFIGURED' });
  assert.throws(() => new QlooProvider({ apiKey: 'test-secret', baseUrl: 'https://attacker.example' }), { code: 'QLOO_CONFIGURATION' });
});

test('Qloo adapter sends real documented query keys and normalizes sparse results', async () => {
  const calls = [];
  const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ success: true, results: { entities: [
      { entity_id: 'place-1', name: 'A venue', query: { affinity: 0.27, explainability: { signal: 'movie-id' } }, popularity: 0.8 },
      { entity_id: 'place-1', name: 'Duplicate' }, { entity_id: 'rejected', name: 'Rejected' }
    ] } }));
  } });
  const candidates = await qloo.discover({ brief: { city: 'Barcelona', avoidEntityIds: ['rejected'] }, references: [{ id: 'movie-id' }], tags: [] });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v2/insights');
  assert.equal(url.searchParams.get('signal.interests.entities'), 'movie-id');
  assert.equal(url.searchParams.get('filter.location.query'), 'Barcelona');
  assert.equal(url.searchParams.get('feature.explainability'), 'true');
  assert.equal(calls[0].options.headers['X-Api-Key'], 'test-secret');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].affinityRaw, 0.27);
  assert.equal(candidates[0].image, null);
  assert.ok(!JSON.stringify(candidates).includes('test-secret'));
});

test('search uses plural types and accepts the raw search array shape', async () => {
  let requestUrl;
  const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async url => {
    requestUrl = new URL(url);
    return new Response(JSON.stringify({ results: [{ entity_id: 'real-id', name: 'Paterson', properties: { release_year: 2016 } }] }));
  } });
  const results = await qloo.search('Paterson', 'movie');
  assert.equal(requestUrl.searchParams.get('types'), 'urn:entity:movie');
  assert.equal(results[0].id, 'real-id');
});

test('upstream errors never expose response bodies or credentials', async () => {
  for (const [status, code] of [[401, 'QLOO_AUTH'], [429, 'QLOO_RATE_LIMIT'], [500, 'QLOO_UPSTREAM']]) {
    const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async () => new Response('test-secret and private diagnostics', { status }) });
    try { await qloo.search('Paterson', 'movie'); assert.fail('expected failure'); } catch (error) {
      assert.equal(error.code, code);
      assert.ok(!JSON.stringify(publicError(error)).includes('test-secret'));
    }
  }
});

test('timeout and request budgets fail visibly without alternate endpoints or sample fallback', async () => {
  let count = 0;
  const qloo = new QlooProvider({ apiKey: 'test-secret', maxRequests: 1, fetchImpl: async () => { count++; throw Object.assign(new Error('secret'), { name: 'TimeoutError' }); } });
  await assert.rejects(qloo.search('A', 'movie'), { code: 'QLOO_TIMEOUT' });
  await assert.rejects(qloo.search('B', 'movie'), { code: 'TOOL_BUDGET' });
  assert.equal(count, 1);
});

test('an upstream response that echoes the server key is withheld even when otherwise valid JSON', async () => {
  const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async () => new Response(JSON.stringify({ results: [{ entity_id: 'id', name: 'test-secret' }] })) });
  await assert.rejects(qloo.search('Paterson', 'movie'), { code: 'QLOO_CONTRACT' });
});

test('a shared quota guard runs before fetch and propagates a safe 429 across provider instances', async () => {
  const budget = createRequestBudget({ env: { FIELDWORK_QLOO_MAX_PER_DAY: '1' } });
  const operations = [];
  let calls = 0;
  const make = () => new QlooProvider({
    apiKey: 'test-secret', beforeRequest(request) { operations.push(request); budget.reserve(request); },
    fetchImpl: async () => { calls++; return Response.json({ results: [] }); },
  });
  const first = make();
  await first.search('Paterson', 'movie');
  const second = make();
  await assert.rejects(second.findTags('gallery'), { code: 'REQUEST_BUDGET_EXHAUSTED', status: 429 });
  assert.equal(calls, 1);
  assert.equal(first.requestCount, 1);
  assert.equal(second.requestCount, 0);
  assert.deepEqual(operations, [{ provider: 'qloo', operation: 'search' }, { provider: 'qloo', operation: 'tags' }]);
  assert.ok(!JSON.stringify(operations).includes('test-secret'));
});

test('failed upstream calls remain reserved; per-run limits block before another global reservation', async () => {
  let reservations = 0;
  const qloo = new QlooProvider({
    apiKey: 'test-secret', maxRequests: 1,
    beforeRequest() { reservations++; },
    fetchImpl: async () => { throw new Error('private network diagnostic'); },
  });
  await assert.rejects(qloo.search('A', 'movie'), { code: 'QLOO_UPSTREAM' });
  await assert.rejects(qloo.search('B', 'movie'), { code: 'TOOL_BUDGET' });
  assert.equal(reservations, 1);
  assert.equal(qloo.requestCount, 1);
});
