import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroqPlanner, DEFAULT_GROQ_MODEL, PLANNER_POLICY } from '../lib/planner.mjs';
import { rehearse } from '../lib/engine.mjs';
import { createApp } from '../server.mjs';
import { AppError } from '../lib/errors.mjs';

const KEY = 'test-only-not-a-real-credential';
const context = (overrides = {}) => ({
  available: ['discover_places'],
  brief: { title: 'Portrait', city: 'Barcelona', note: 'Quiet frames', placeKinds: ['gallery'], references: [{ query: 'Perfect Days', domain: 'movie' }] },
  candidates: [], lockedIds: [], observations: [], ...overrides
});
const selection = (overrides = {}) => context({
  available: ['select_treatments', 'relax_preferences'],
  candidates: [{ id: 'a', kind: 'gallery' }, { id: 'b', kind: 'garden' }, { id: 'c', kind: 'bookshop' }],
  lockedIds: ['a'], ...overrides
});
const discovery = { action: 'discover_places', usePreferences: true };
const response = (decision = discovery, overrides = {}) => new Response(JSON.stringify({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision && (decision.action === 'discover_places' ? decision : { creativeProposals: [], ...decision })) } }], ...overrides
}));

test('Groq sends only bounded observations to the fixed endpoint using strict structured actions', async () => {
  let seen;
  let reservation;
  const planner = createGroqPlanner({ apiKey: KEY, beforeRequest: metadata => { reservation = metadata; }, fetchImpl: async (url, options) => {
    seen = { url, options, body: JSON.parse(options.body) };
    return response();
  } });
  const result = await planner.choose(context());
  assert.deepEqual(result, { action: 'discover_places', usePreferences: true, planner: 'groq', model: DEFAULT_GROQ_MODEL });
  assert.equal(seen.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(seen.options.signal.aborted, false);
  assert.equal(seen.body.stream, false);
  assert.equal(seen.body.include_reasoning, false);
  assert.equal(seen.body.tools, undefined);
  assert.equal(seen.body.max_completion_tokens, 1300);
  const { strict, schema } = seen.body.response_format.json_schema;
  assert.equal(strict, true);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, Object.keys(schema.properties));
  assert.deepEqual(schema.properties.action.enum, ['discover_places']);
  assert.equal(reservation.operation, 'chat');
  assert.equal(reservation.maxInputBytes, Buffer.byteLength(seen.options.body));
  assert.equal(seen.options.body.includes(KEY), false);
  assert.equal(JSON.stringify(planner).includes(KEY), false);
  assert.equal(planner.calls, 1);
});

test('Groq may select observed candidates in a different order while preserving fixed decisions', async () => {
  let request;
  const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return response({ action: 'select_treatments', candidateIds: ['c', 'a'] });
  } });
  const result = await planner.choose(selection());
  assert.equal(result.planner, 'groq');
  assert.deepEqual(result.candidateIds, ['c', 'a']);
  const properties = request.response_format.json_schema.schema.properties;
  assert.equal(properties.usePreferences, undefined);
  assert.deepEqual(request.response_format.json_schema.schema.required, ['action', 'candidateIds', 'creativeProposals']);
  assert.equal(request.response_format.json_schema.strict, true);
  assert.ok(properties.candidateIds.items.enum.includes('a'));
  assert.deepEqual(properties.creativeProposals.items.properties.candidateId.enum, ['b', 'c']);
  assert.match(properties.creativeProposals.items.properties.tagline.description, /5–9 words.*70 characters.*100/);
  assert.match(request.messages[0].content, /tagline \(5–9 words, target max 70 characters, hard max 100/);
  const observation = JSON.parse(request.messages[1].content);
  assert.equal(observation.expectedCreativeProposalCount, 1);
  assert.deepEqual(observation.creativeCandidateIds, ['b', 'c']);
});

test('discovery with a fixed choice requests empty action arguments without asking the model to repeat the lock', async () => {
  let request;
  const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return response();
  } });
  const result = await planner.choose(context({ candidates: [{ id: 'fixed', kind: 'gallery' }], lockedIds: ['fixed'] }));
  assert.equal(result.planner, 'groq');
  assert.equal(result.action, 'discover_places');
  const properties = request.response_format.json_schema.schema.properties;
  assert.equal(properties.candidateIds, undefined);
  assert.equal(properties.creativeProposals, undefined);
  assert.deepEqual(request.response_format.json_schema.schema.required, ['action', 'usePreferences']);
  assert.match(request.messages[0].content, /controller preserves all locked decisions automatically/);
  const invalid = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => response({ ...discovery, candidateIds: ['fixed'] }) });
  assert.equal((await invalid.choose(context({ candidates: [{ id: 'fixed', kind: 'gallery' }], lockedIds: ['fixed'] }))).fallbackCode, 'GROQ_CONTRACT');
});

test('usePreferences is required only for discovery, and relaxation keeps its selection arrays empty', async () => {
  const missingDiscoveryFlag = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => response({ action: 'discover_places' }) });
  assert.equal((await missingDiscoveryFlag.choose(context())).fallbackCode, 'GROQ_CONTRACT');
  let schema;
  const relaxation = createGroqPlanner({ apiKey: KEY, fetchImpl: async (_url, options) => {
    schema = JSON.parse(options.body).response_format.json_schema.schema;
    return response({ action: 'relax_preferences', candidateIds: [], creativeProposals: [] });
  } });
  const result = await relaxation.choose(selection({ available: ['relax_preferences'] }));
  assert.equal(result.planner, 'groq');
  assert.equal(result.action, 'relax_preferences');
  assert.equal(schema.properties.usePreferences, undefined);
  assert.deepEqual(schema.required, ['action', 'candidateIds', 'creativeProposals']);
  assert.equal(schema.additionalProperties, false);
});

test('invalid, injected, invented and lock-breaking actions cannot enter the brief', async t => {
  const badActions = [
    { action: 'select_treatments', candidateIds: ['a', 'invented'] },
    { action: 'select_treatments', candidateIds: ['b', 'c'] },
    { action: 'select_treatments', candidateIds: ['a', 'a'] },
    { action: 'select_treatments', candidateIds: ['a'] },
    { action: 'select_treatments', candidateIds: ['a', 'b', 'c'] },
    { action: 'select_treatments', usePreferences: false, candidateIds: ['a', 'b'] },
    { action: 'select_treatments', candidateIds: ['a', 'b'], secret: KEY },
    { action: 'fetch_url', candidateIds: [] },
    { action: 'relax_preferences', candidateIds: ['a'] },
    null
  ];
  for (const [index, action] of badActions.entries()) await t.test(`invalid action ${index + 1}`, async () => {
    const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => response(action) });
    const result = await planner.choose(selection());
    assert.equal(result.planner, PLANNER_POLICY);
    assert.equal(result.fallbackCode, 'GROQ_CONTRACT');
    assert.ok(result.candidateIds.includes('a'));
    assert.equal(JSON.stringify(result).includes(KEY), false);
  });
});

test('credential, model and per-run limits prevent network use and expose a reason', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(); };
  assert.equal((await createGroqPlanner({ fetchImpl }).choose(context())).fallbackCode, 'GROQ_NOT_CONFIGURED');
  assert.equal((await createGroqPlanner({ apiKey: KEY, model: 'unexpected-model', fetchImpl }).choose(context())).fallbackCode, 'GROQ_CONFIGURATION');
  assert.equal((await createGroqPlanner({ apiKey: KEY, timeoutMs: 90_000, fetchImpl }).choose(context())).fallbackCode, 'GROQ_CONFIGURATION');
  assert.equal(calls, 0);
  const planner = createGroqPlanner({ apiKey: KEY, maxCalls: 1, fetchImpl });
  await planner.choose(context());
  assert.equal((await planner.choose(context())).fallbackCode, 'GROQ_BUDGET');
  assert.equal(calls, 1);
});

test('shared budget failure propagates before any Groq request or policy continuation', async () => {
  const budgetError = new AppError('REQUEST_BUDGET', 'The shared demo allowance was reached.', 429);
  const planner = createGroqPlanner({ apiKey: KEY, beforeRequest: () => { throw budgetError; }, fetchImpl: async () => { assert.fail('No request may be sent'); } });
  await assert.rejects(planner.choose(context()), error => error === budgetError);
  assert.equal(planner.calls, 0);
});

test('upstream failures stay sanitized and do not retry during the same scout', async t => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'UPSTREAM'], [302, 'UPSTREAM']]) await t.test(`HTTP ${status}`, async () => {
    let count = 0;
    const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => { count++; return new Response(`private data ${KEY}`, { status }); } });
    const first = await planner.choose(context());
    assert.equal(first.fallbackCode, `GROQ_${code}`);
    assert.ok(first.fallbackDetailCodes.includes(`HTTP_${status}`));
    assert.match(first.fallback, /explicit bounded policy/);
    assert.equal(JSON.stringify(first).includes(KEY), false);
    await planner.choose(context());
    assert.equal(count, 1);
  });
  const timeout = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => { throw new DOMException(`private ${KEY}`, 'TimeoutError'); } });
  assert.equal((await timeout.choose(context())).fallbackCode, 'GROQ_TIMEOUT');
});

test('failed selection exposes only bounded HTTP and allowlisted provider diagnostics in the existing trace', async () => {
  let calls = 0;
  const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => {
    if (++calls === 1) return response();
    return Response.json({ error: { type: 'invalid_request_error', code: 'json_validate_failed', message: 'PRIVATE_PROVIDER_TEXT', failed_generation: { private: 'PRIVATE_GENERATION_TEXT' } } }, { status: 400, headers: { 'x-private': 'PRIVATE_HEADER' } });
  } });
  const state = await rehearse({ exampleId: 'quiet-city' }, { planner });
  assert.equal(state.provenance.modelActions, 1);
  assert.equal(state.provenance.policyActions, 1);
  const failed = state.trace.find(t => t.fallbackCode === 'GROQ_UPSTREAM');
  assert.match(failed.outputSummary, /HTTP_400, PROVIDER_INVALID_REQUEST, PROVIDER_JSON_VALIDATE_FAILED/);
  assert.ok(state.warnings.some(w => w.includes('Groq could not complete the request')));
  assert.ok(state.warnings.every(w => !w.includes('HTTP_400') && !w.includes('PROVIDER_')));
  for (const secret of [KEY, 'PRIVATE_PROVIDER_TEXT', 'PRIVATE_GENERATION_TEXT', 'PRIVATE_HEADER']) assert.equal(JSON.stringify(state).includes(secret), false);
  const latched = await planner.choose(selection());
  assert.deepEqual(latched.fallbackDetailCodes, ['HTTP_400', 'PROVIDER_INVALID_REQUEST', 'PROVIDER_JSON_VALIDATE_FAILED']);
  assert.ok(!latched.fallback.includes('HTTP_400'));
  assert.equal(calls, 2);
});

test('unknown, secret-bearing and oversized provider diagnostics cannot become public text', async t => {
  const cases = [
    { name: 'unknown fields', body: JSON.stringify({ error: { type: 'PRIVATE_TYPE', code: 'PRIVATE_CODE', message: 'PRIVATE_MESSAGE' } }), expected: ['HTTP_500', 'PROVIDER_TYPE_UNRECOGNIZED', 'PROVIDER_CODE_UNRECOGNIZED'] },
    { name: 'credential echo', body: JSON.stringify({ error: { code: KEY } }), expected: ['HTTP_500', 'PROVIDER_BODY_WITHHELD'] },
    { name: 'oversized body', body: JSON.stringify({ error: { message: 'x'.repeat(4097), type: 'server_error' } }), expected: ['HTTP_500'] }
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => new Response(item.body, { status: 500 }) });
    const result = await planner.choose(context());
    assert.equal(result.fallbackCode, 'GROQ_UPSTREAM');
    assert.deepEqual(result.fallbackDetailCodes, item.expected);
    for (const secret of [KEY, 'PRIVATE_TYPE', 'PRIVATE_CODE', 'PRIVATE_MESSAGE']) assert.equal(JSON.stringify(result).includes(secret), false);
  });
});

test('network causes use fixed diagnostic tokens without exposing exception text or retrying', async () => {
  let calls = 0;
  const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => {
    calls++;
    throw new TypeError(`private ${KEY}`, { cause: { code: 'ECONNRESET', message: 'PRIVATE_NETWORK_TEXT' } });
  } });
  const result = await planner.choose(context());
  assert.equal(result.fallbackCode, 'GROQ_UPSTREAM');
  assert.deepEqual(result.fallbackDetailCodes, ['NETWORK_RESET']);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_NETWORK_TEXT'), false);
  await planner.choose(context());
  assert.equal(calls, 1);
});

test('oversized, truncated, refused, malformed or secret-bearing responses are rejected', async t => {
  const responses = [
    () => new Response('x'.repeat(32_769)),
    () => new Response('{}', { headers: { 'content-length': '500000' } }),
    () => new Response('not JSON'),
    () => response(discovery, { private: KEY }),
    () => response(discovery, { choices: [{ finish_reason: 'length', message: { content: JSON.stringify(discovery) } }] }),
    () => response(discovery, { choices: [{ finish_reason: 'stop', message: { refusal: 'no', content: JSON.stringify(discovery) } }] }),
    () => response(discovery, { choices: [{ finish_reason: 'stop', message: { tool_calls: [], content: JSON.stringify(discovery) } }] })
  ];
  for (const [index, makeResponse] of responses.entries()) await t.test(`unusable response ${index + 1}`, async () => {
    const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => makeResponse() });
    const result = await planner.choose(context());
    assert.equal(result.fallbackCode, 'GROQ_CONTRACT');
    assert.equal(JSON.stringify(result).includes(KEY), false);
  });
});

test('over-budget inputs and accidental credential contents are withheld before transport', async () => {
  const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async () => { assert.fail('Input must be withheld'); } });
  const initial = context();
  initial.brief.note = 'x'.repeat(21_000);
  assert.equal((await planner.choose(initial)).fallbackCode, 'GROQ_CONTRACT');
  initial.brief.note = KEY;
  assert.equal((await planner.choose(initial)).fallbackCode, 'GROQ_CONTRACT');
  assert.equal(planner.calls, 0);
});

test('engine provenance distinguishes Groq actions, mixed execution and complete fallback', async () => {
  for (const variant of ['model', 'mixed', 'policy']) {
    const planner = createGroqPlanner({ apiKey: KEY, fetchImpl: async (_url, options) => {
      const observation = JSON.parse(JSON.parse(options.body).messages[1].content);
      if (variant === 'policy' || variant === 'mixed' && observation.candidates.length) return new Response('unavailable', { status: 503 });
      return response(observation.availableTools.includes('discover_places') ? discovery : { action: 'select_treatments', candidateIds: observation.candidates.slice(-2).map(c => c.id) });
    } });
    const state = await rehearse({ exampleId: 'quiet-city' }, { planner });
    assert.equal(state.provenance.configuredPlanner, 'groq');
    assert.equal(state.provenance.planner, { model: 'groq', mixed: 'groq-with-policy-fallback', policy: PLANNER_POLICY }[variant]);
    assert.equal(state.provenance.qlooUsed, false);
    assert.equal(state.provenance.model, variant === 'policy' ? null : DEFAULT_GROQ_MODEL);
    assert.equal(state.provenance.modelActions, { model: 2, mixed: 1, policy: 0 }[variant]);
    assert.equal(state.trace.filter(t => t.planner === 'groq').every(t => t.outputSummary.startsWith('Groq model ')), true);
    if (variant !== 'model') assert.ok(state.trace.some(t => t.fallbackCode === 'GROQ_UPSTREAM' && t.outputSummary.includes('no Groq model action')));
  }
});

test('server reports missing Groq credentials and rejects unknown planners without network use', async () => {
  for (const mode of ['groq', 'unknown']) {
    const server = createApp({ env: { FIELDWORK_PLANNER: mode } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, mode === 'groq' ? 200 : 503);
      const body = await health.json();
      if (mode === 'groq') {
        assert.equal(body.plannerConfigured, false);
        assert.equal(body.planner, 'groq');
        const result = await (await fetch(`${base}/api/rehearse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exampleId: 'quiet-city' }) })).json();
        assert.equal(result.provenance.planner, PLANNER_POLICY);
        assert.ok(result.warnings.some(w => w.includes('Groq is not configured')));
      } else assert.equal(body.error.code, 'PLANNER_CONFIGURATION');
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});
