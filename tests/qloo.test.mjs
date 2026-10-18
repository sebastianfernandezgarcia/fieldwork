import test from 'node:test';
import assert from 'node:assert/strict';
import { QlooProvider } from '../lib/qloo.mjs';
import { publicError } from '../lib/errors.mjs';
import { createRequestBudget } from '../lib/request-budget.mjs';
import { rehearse } from '../lib/engine.mjs';

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

test('documented search 404 pauses for another reference without discovering places', async () => {
  const paths = [];
  const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async url => {
    paths.push(new URL(url).pathname);
    return new Response('private diagnostics test-secret', { status: 404 });
  } });
  const state = await rehearse({ dataMode: 'live', brief: {
    city: 'Barcelona', references: [{ query: 'An unmatched synthetic movie', domain: 'movie' }], placeKinds: ['gallery'],
  } }, { provider: qloo });
  assert.equal(state.status, 'needs_input');
  assert.equal(state.resolutionIssues.length, 1);
  assert.deepEqual(state.resolutionIssues[0].candidates, []);
  assert.deepEqual(state.candidates, []);
  assert.deepEqual(paths, ['/search']);
  assert.equal(qloo.requestCount, 1);
  assert.ok(!JSON.stringify(state).includes('test-secret'));
});

test('404 from tags or insights remains an upstream error, not an empty successful search', async () => {
  const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async () => new Response('private diagnostics', { status: 404 }) });
  await assert.rejects(qloo.findTags('gallery'), { code: 'QLOO_UPSTREAM' });
  await assert.rejects(qloo.discover({ brief: { city: 'Barcelona', avoidEntityIds: [] }, references: [{ id: 'synthetic-reference' }] }), { code: 'QLOO_UPSTREAM' });
});

test('tag resolution accepts both documented identifier shapes and preserves the semantic-search query', async t => {
  for (const key of ['id', 'tag_id']) await t.test(key, async () => {
    let request;
    const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async url => {
      request = new URL(url);
      return Response.json({ results: { tags: [{ [key]: 'synthetic-tag-gallery', name: 'Gallery' }] } });
    } });
    assert.deepEqual(await qloo.findTags('gallery'), [{ id: 'synthetic-tag-gallery', name: 'Gallery', source: 'qloo' }]);
    assert.equal(request.pathname, '/v2/tags');
    assert.equal(request.searchParams.get('filter.query'), 'gallery');
    assert.equal(request.searchParams.get('feature.semantic_search'), 'true');
    assert.equal(request.searchParams.get('take'), '5');
  });
});

test('tag parents select a unique place category instead of an identically named media category', async () => {
  const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async () => Response.json({ results: { tags: [
    { id: 'synthetic-media', name: 'Gallery', parents: [{ type: 'urn:entity:movie' }] },
    { tag_id: 'synthetic-place', name: 'Gallery', parents: [{ type: 'urn:entity:place' }] },
    { id: 'synthetic-unscoped', name: 'Gallery' },
  ] } }) });
  assert.deepEqual(await qloo.findTags('gallery'), [{ id: 'synthetic-place', name: 'Gallery', source: 'qloo' }]);
});

test('ambiguous, wrong-parent and only-semantic tags remain unconfirmed preferences', async t => {
  const cases = [
    { name: 'ambiguous exact place names', tags: [
      { id: 'synthetic-one', name: 'Gallery', parents: [{ type: 'urn:entity:place' }] },
      { tag_id: 'synthetic-two', name: 'Gallery', parents: [{ type: 'urn:entity:place' }] },
    ] },
    { name: 'known non-place parent', tags: [{ id: 'synthetic-media', name: 'Gallery', parents: [{ type: 'urn:entity:movie' }] }] },
    { name: 'only a related name', tags: [{ id: 'synthetic-related', name: 'Art museum' }] },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async () => Response.json({ results: { tags: item.tags } }) });
    assert.deepEqual(await qloo.findTags('gallery'), []);
  });
});

test('duplicate records for one exact tag ID do not create false ambiguity', async () => {
  const qloo = new QlooProvider({ apiKey: 'test-secret', fetchImpl: async () => Response.json({ results: { tags: [
    { id: 'synthetic-same', name: 'Gallery' }, { tag_id: 'synthetic-same', name: 'Gallery' },
  ] } }) });
  assert.deepEqual(await qloo.findTags('gallery'), [{ id: 'synthetic-same', name: 'Gallery', source: 'qloo' }]);
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
