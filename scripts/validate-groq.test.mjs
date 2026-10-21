import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseOptions, validateGroq, writeReceipt } from './validate-groq.mjs';

const env = { GROQ_API_KEY: 'unit-test-not-a-real-groq-credential' };
function simulatedGroq({ failureStatus, echoCredential = false, invalidProposals = false } = {}) {
  let count = 0;
  return {
    get count() { return count; },
    async fetch(url, options) {
      count++;
      assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(options.headers.Authorization, `Bearer ${env.GROQ_API_KEY}`);
      assert.equal(options.redirect, 'error');
      if (failureStatus) return new Response(env.GROQ_API_KEY, { status: failureStatus });
      const request = JSON.parse(options.body);
      const observation = JSON.parse(request.messages[1].content);
      const discovery = observation.availableTools.includes('discover_places');
      const ids = discovery ? [] : observation.candidates.slice(0, 2).map(c => c.id);
      const decision = {
        action: 'select_treatments', candidateIds: ids,
        creativeProposals: invalidProposals ? [] : ids.map((candidateId, index) => ({
          candidateId, title: `Synthetic direction ${index + 1}`, tagline: `Try sequence ${index + 1}.`,
          premise: `Propose gesture ${index + 1} for the test musician. Confirm feasibility on the scout.`,
          shots: [1, 2, 3].map(number => ({ label: `Shot ${number}`, note: `Try composition ${number}, then review it with the subject.` }))
        }))
      };
      const action = discovery ? { action: 'discover_places', usePreferences: false } : decision;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action) } }], ...(echoCredential ? { unexpectedPrivateValue: env.GROQ_API_KEY } : {}) });
    }
  };
}

test('probe is opt-in, requires a finite explicit budget and refuses missing credentials before transport', async () => {
  assert.equal(parseOptions([]).executeLive, false);
  assert.throws(() => parseOptions(['--execute-live']));
  for (const input of ['0', '3', 'Infinity', 'two', '1.5']) assert.throws(() => parseOptions(['--max-groq-requests', input]));
  assert.equal(parseOptions(['--execute-live', '--max-groq-requests', '2']).maxRequests, 2);
  await assert.rejects(validateGroq({ env: {}, maxRequests: 2, groqFetch: () => assert.fail('No request without credential') }));
});

test('two bounded actions validate creative proposals while simulation never claims authenticated Groq or real Qloo', async () => {
  const simulator = simulatedGroq();
  const receipt = await validateGroq({ env, maxRequests: 2, groqFetch: simulator.fetch, transport: 'simulation' });
  assert.equal(receipt.passed, true);
  assert.equal(receipt.schemaVersion, 'fieldwork.groq-validation.v2');
  assert.equal(receipt.requestCount, 2);
  assert.equal(simulator.count, 2);
  assert.deepEqual(receipt.requests.map(r => [r.completionPhase, r.requestedMaxTokens]), [['action', 1300], ['selection', 2400]]);
  assert.equal(receipt.liveGroqVerified, false);
  assert.equal(receipt.liveQlooVerified, false);
  assert.equal(receipt.syntheticCandidates, true);
  assert.equal(receipt.qlooRequests, 0);
  assert.deepEqual(receipt.verification, { authenticatedGroq: false, modelSelection: true, creativeContract: true, realQloo: false, venueFacts: false });
  assert.equal(receipt.outputSha256.length, 64);
  assert.ok(receipt.checks.every(check => check.passed));
  const text = JSON.stringify(receipt);
  for (const forbidden of [env.GROQ_API_KEY, 'Synthetic direction', 'Try composition', 'Bearer ', 'message', 'creativeProposals', 'Khruangbin']) assert.equal(text.includes(forbidden), false);
});

test('a one-request allowance stops the second request with no retry or false completion', async () => {
  const simulator = simulatedGroq();
  const receipt = await validateGroq({ env, maxRequests: 1, groqFetch: simulator.fetch, transport: 'simulation' });
  assert.equal(simulator.count, 1);
  assert.equal(receipt.requestCount, 1);
  assert.equal(receipt.failureCode, 'PROBE_BUDGET');
  assert.equal(receipt.passed, false);
});

test('authentication, quota and echoed secrets produce only safe failure codes and one request', async () => {
  for (const settings of [{ failureStatus: 401 }, { failureStatus: 429 }, { echoCredential: true }]) {
    const simulator = simulatedGroq(settings);
    const receipt = await validateGroq({ env, maxRequests: 2, groqFetch: simulator.fetch, transport: 'simulation' });
    assert.equal(simulator.count, 1);
    assert.equal(receipt.passed, false);
    assert.ok(['GROQ_AUTH', 'GROQ_RATE_LIMIT', 'GROQ_CONTRACT'].includes(receipt.failureCode));
    assert.equal(JSON.stringify(receipt).includes(env.GROQ_API_KEY), false);
  }
});

test('model selection alone does not pass a probe requiring actual validated creative proposals', async () => {
  const simulator = simulatedGroq({ invalidProposals: true });
  const receipt = await validateGroq({ env, maxRequests: 2, groqFetch: simulator.fetch, transport: 'simulation' });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.failureCode, 'PROBE_VALIDATION');
  assert.deepEqual(receipt.creativeFailureCodes, ['CREATIVE_PROPOSAL_COUNT']);
  assert.equal(receipt.checks.find(c => c.id === 'two-valid-model-proposals').passed, false);
});

test('sanitized receipt is private on disk and secret-bearing data is never written', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fieldwork-groq-probe-'));
  try {
    const simulator = simulatedGroq();
    const receipt = await validateGroq({ env, maxRequests: 2, groqFetch: simulator.fetch, transport: 'simulation' });
    const file = await writeReceipt(receipt, { root, secrets: [env.GROQ_API_KEY] });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readFile(file, 'utf8')).includes(env.GROQ_API_KEY), false);
    await assert.rejects(writeReceipt({ ...receipt, private: env.GROQ_API_KEY }, { root, secrets: [env.GROQ_API_KEY] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
