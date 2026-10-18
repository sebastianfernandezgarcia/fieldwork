import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseOptions, validateLive, publicSummary, writeReceipts } from './validate-live.mjs';

const env = { QLOO_API_KEY: 'validation-simulator-secret', QLOO_API_BASE_URL: 'https://api.qloo.com' };

function simulator({ authFailure = false, ambiguous = false, injectSecret = false } = {}) {
  const calls = [];
  const qlooFetch = async (url, options) => {
    url = new URL(url);
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    assert.equal(options.headers['X-Api-Key'], env.QLOO_API_KEY);
    assert.equal(options.redirect, 'error');
    if (authFailure) return new Response(env.QLOO_API_KEY, { status: 401 });
    if (url.pathname === '/search') {
      const name = injectSecret ? env.QLOO_API_KEY : url.searchParams.get('query');
      const entity = { entity_id: `ref-${calls.length}`, name, subtype: url.searchParams.get('types') };
      return Response.json({ results: ambiguous ? [entity, { ...entity, entity_id: `other-${calls.length}` }] : [entity] });
    }
    if (url.pathname === '/v2/tags') return Response.json({ results: { tags: [{ id: `tag:${url.searchParams.get('filter.query')}`, name: url.searchParams.get('filter.query') }] } });
    if (url.pathname === '/v2/insights') {
      const city = url.searchParams.get('filter.location.query');
      const excluded = new Set((url.searchParams.get('filter.exclude.entities') || '').split(','));
      const entities = ['one', 'two', 'three', 'four'].map((suffix, i) => ({
        entity_id: `${city}-${suffix}`, name: `Simulator place ${i + 1}`, subtype: 'urn:entity:place',
        query: { affinity: 0.9 - i / 10 }, popularity: i / 10,
        tags: [{ name: i % 2 ? 'gallery' : 'bookshop' }],
      })).filter(e => !excluded.has(e.entity_id));
      return Response.json({ results: { entities } });
    }
    throw new Error('Unexpected simulated endpoint');
  };
  return { qlooFetch, calls };
}

test('execution is opt-in and a finite total request budget is mandatory', () => {
  assert.equal(parseOptions([]).executeLive, false);
  assert.throws(() => parseOptions(['--execute-live']));
  for (const value of ['0', '25', 'Infinity', '1.5', 'no']) assert.throws(() => parseOptions(['--max-qloo-requests', value]));
  assert.equal(parseOptions(['--execute-live', '--max-qloo-requests', '20']).maxRequests, 20);
});

test('real HTTP handler validates two briefs, exact lock preservation, veto and export without claiming simulation is live evidence', async () => {
  const transport = simulator();
  const receipt = await validateLive({ env, maxRequests: 20, transport: 'simulation', qlooFetch: transport.qlooFetch });
  assert.equal(receipt.passed, true);
  assert.equal(receipt.requestCount, 18);
  assert.equal(transport.calls.length, 18);
  assert.equal(receipt.checks.filter(c => !c.passed).length, 0);
  assert.equal(receipt.checks.length, 10);
  assert.equal(publicSummary(receipt).liveQlooVerified, false);
  const lastInsights = transport.calls.filter(c => c.path === '/v2/insights').at(-1);
  assert.ok(lastInsights.query['filter.exclude.entities']);
  assert.equal(lastInsights.query['filter.location.radius'], '0');
  assert.ok(!JSON.stringify(receipt).includes(env.QLOO_API_KEY));
});

test('global budget stops all further upstream calls across separate provider instances', async () => {
  const transport = simulator();
  const receipt = await validateLive({ env, maxRequests: 7, transport: 'simulation', qlooFetch: transport.qlooFetch });
  assert.equal(transport.calls.length, 7);
  assert.equal(receipt.requestCount, 7);
  assert.equal(receipt.failureCode, 'GLOBAL_QLOO_BUDGET');
  assert.equal(receipt.passed, false);
});

test('validation preserves the actual application provider quota and identifies hosted planner provenance', async () => {
  const transport = simulator();
  const receipt = await validateLive({ env: { ...env, FIELDWORK_QLOO_MAX_PER_DAY: '2' }, maxRequests: 20, transport: 'simulation', qlooFetch: transport.qlooFetch });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.failureCode, 'REQUEST_BUDGET_EXHAUSTED');
  assert.equal(transport.calls.length, 2);
  const clean = simulator();
  const full = await validateLive({ env, maxRequests: 20, transport: 'simulation', qlooFetch: clean.qlooFetch });
  full.states.find(s => s.label === 'brief-1').state.provenance.planner = 'groq-with-policy-fallback';
  assert.equal(publicSummary(full).briefs[0].planner, 'groq-with-policy-fallback');
  assert.equal(publicSummary(full).liveQlooVerified, false);
});

test('authentication and echoed credentials stop safely, with no retries or raw diagnostics', async () => {
  for (const settings of [{ authFailure: true }, { injectSecret: true }]) {
    const transport = simulator(settings);
    const receipt = await validateLive({ env, maxRequests: 20, transport: 'simulation', qlooFetch: transport.qlooFetch });
    assert.equal(transport.calls.length, 1);
    assert.equal(receipt.passed, false);
    assert.ok(['QLOO_AUTH', 'QLOO_CONTRACT'].includes(receipt.failureCode));
    assert.ok(!JSON.stringify(receipt).includes(env.QLOO_API_KEY));
  }
});

test('ambiguous cultural references remain a manual choice and never pass validation', async () => {
  const transport = simulator({ ambiguous: true });
  const receipt = await validateLive({ env, maxRequests: 20, transport: 'simulation', qlooFetch: transport.qlooFetch });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.failureCode, 'REFERENCE_CHOICE_REQUIRED');
  assert.equal(transport.calls.filter(c => c.path === '/v2/insights').length, 0);
  assert.equal(receipt.requestCount, 6);
});

test('receipts separate private normalized states from public counts and enforce file permissions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fieldwork-live-validation-'));
  try {
    const transport = simulator();
    const receipt = await validateLive({ env, maxRequests: 20, transport: 'simulation', qlooFetch: transport.qlooFetch });
    receipt.privateDebugForTest = env.QLOO_API_KEY;
    const output = await writeReceipts(receipt, { root: directory, secrets: [env.QLOO_API_KEY] });
    const privateText = await readFile(output.privatePath, 'utf8');
    const summaryText = await readFile(output.publicPath, 'utf8');
    assert.equal((await stat(output.privatePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(output.privatePath))).mode & 0o777, 0o700);
    assert.ok(!privateText.includes(env.QLOO_API_KEY));
    assert.ok(!summaryText.includes('Simulator place'));
    assert.ok(!summaryText.includes('sourceQuery'));
    assert.ok(!summaryText.includes('runId'));
    assert.ok(!summaryText.includes(env.QLOO_API_KEY));
    assert.equal(output.summary.privateReceiptSha256.length, 64);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
