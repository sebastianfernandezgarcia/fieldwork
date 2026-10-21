import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGroqPlanner, DEFAULT_GROQ_MODEL } from '../lib/planner.mjs';
import { exampleById, rehearse } from '../lib/engine.mjs';
import { FixtureProvider } from '../lib/fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const SAFE_FAILURES = new Set(['GROQ_NOT_CONFIGURED', 'GROQ_CONFIGURATION', 'GROQ_AUTH', 'GROQ_RATE_LIMIT', 'GROQ_TIMEOUT', 'GROQ_UPSTREAM', 'GROQ_CONTRACT', 'GROQ_BUDGET', 'PROBE_BUDGET', 'PROBE_ENDPOINT', 'PROBE_VALIDATION']);
const failure = code => Object.assign(new Error('The Groq probe stopped. See the sanitized checks.'), { code });

export function parseOptions(args) {
  const options = { executeLive: false, maxRequests: null, help: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--execute-live') options.executeLive = true;
    else if (args[index] === '--max-groq-requests') options.maxRequests = Number(args[++index]);
    else if (['--help', '-h'].includes(args[index])) options.help = true;
    else throw new Error('Unknown option. Use --help.');
  }
  if (options.maxRequests !== null && (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 2)) throw new Error('The Groq probe permits a budget of 1 or 2 requests.');
  if (options.executeLive && options.maxRequests === null) throw new Error('Live execution requires --max-groq-requests.');
  return options;
}

export async function validateGroq({ env, maxRequests, groqFetch = fetch, transport = 'live' } = {}) {
  if (typeof env?.GROQ_API_KEY !== 'string' || !env.GROQ_API_KEY.trim()) throw new Error('Configure GROQ_API_KEY in the server environment before executing.');
  if (env.GROQ_MODEL && env.GROQ_MODEL !== DEFAULT_GROQ_MODEL) throw new Error('This probe only permits the configured GPT-OSS 20B adapter.');
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 2) throw new Error('Choose a request budget of 1 or 2.');
  if (!['live', 'simulation'].includes(transport)) throw new Error('Unknown probe transport.');
  const started = performance.now();
  const receipt = {
    schemaVersion: 'fieldwork.groq-validation.v2', startedAt: new Date().toISOString(),
    transport, model: DEFAULT_GROQ_MODEL, syntheticCandidates: true, liveQlooVerified: false, qlooRequests: 0,
    requestBudget: maxRequests, requests: [], checks: [],
    scope: 'Authenticated Groq planner with fictional FixtureProvider candidates and a public-reference brief. This does not verify real Qloo data, venue conditions or public hosting.',
    storage: 'Only checks, counts, fixed metadata and a normalized-output hash are retained. No credential, prompt, raw provider response, creative text or private model reasoning is stored.'
  };
  let reservations = 0;
  let contractFailure = null;
  const planner = createGroqPlanner({
    apiKey: env.GROQ_API_KEY, model: DEFAULT_GROQ_MODEL, maxCalls: 2,
    beforeRequest() {
      if (reservations >= maxRequests) throw failure('PROBE_BUDGET');
      reservations++;
    },
    async fetchImpl(url, options) {
      if (url !== ENDPOINT || options.redirect !== 'error' || receipt.requests.length >= maxRequests) {
        contractFailure = 'PROBE_ENDPOINT';
        throw failure(contractFailure);
      }
      const body = JSON.parse(options.body);
      const selectionAllowed = body.response_format?.json_schema?.schema?.properties?.action?.enum?.includes('select_treatments') === true;
      const request = { index: receipt.requests.length + 1, httpStatus: null, durationMs: null, strictSchemaRequested: body.response_format?.type === 'json_schema' && body.response_format?.json_schema?.strict === true, requestedMaxTokens: body.max_completion_tokens, completionPhase: selectionAllowed ? 'selection' : 'action' };
      receipt.requests.push(request);
      const begin = performance.now();
      try {
        const response = await groqFetch(url, options);
        request.httpStatus = response.status;
        return response;
      } finally { request.durationMs = Math.round(performance.now() - begin); }
    }
  });
  const check = (id, passed) => receipt.checks.push({ id, passed: Boolean(passed) });
  try {
    const brief = exampleById('quiet-city');
    brief.title = 'Synthetic planner validation: a record sleeve';
    brief.note = 'Public-reference test only. Propose one restrained portrait narrative and one more rhythmic sequence for a fictional independent musician. Do not assert physical venue features.';
    // No soft category filter means the actual loop has only discover + select.
    // The fixture provider performs no network access and cannot become Qloo.
    brief.placeKinds = [];
    const state = await rehearse({ brief, dataMode: 'fixture' }, { provider: new FixtureProvider(), planner });
    check('ready-with-two-treatments', state.status === 'ready' && state.treatments.length === 2);
    check('two-model-actions-without-policy-fallback', state.provenance.planner === 'groq' && state.provenance.modelActions === 2 && state.provenance.policyActions === 0 && planner.calls === 2);
    check('fixture-source-preserved', state.dataMode === 'fixture' && !state.provenance.qlooUsed && state.candidates.every(c => c.source === 'fixture'));
    check('two-valid-model-proposals', state.treatments.length === 2 && state.treatments.every(t => t.editorial.source === 'model-proposed' && t.editorial.provider === 'groq' && t.editorial.model === DEFAULT_GROQ_MODEL && t.editorial.shots.length === 3));
    check('proposal-action-form-not-factual-verification', state.treatments.length === 2 && state.treatments.every(t => t.editorial.validation?.policy === 'proposal-action-form-v1' && t.editorial.validation.actionFormChecked && t.editorial.validation.factualVerification === false));
    check('different-creative-directions', state.treatments.length === 2 && state.treatments[0].title !== state.treatments[1].title && state.treatments[0].editorial.premise !== state.treatments[1].editorial.premise);
    const safeCreativeCodes = new Set(['CREATIVE_PROPOSAL_COUNT', 'CREATIVE_ACTION_FORM', 'CREATIVE_CANDIDATE_BINDING', 'CREATIVE_SHOT_COUNT', 'CREATIVE_TEXT_LIMIT', 'CREATIVE_CONTRACT']);
    receipt.creativeFailureCodes = [...new Set(state.treatments.map(t => t.editorial.fallbackCode).filter(code => safeCreativeCodes.has(code)))];
    const fallbackCode = state.trace.find(t => t.fallbackCode)?.fallbackCode;
    if (fallbackCode) receipt.failureCode = SAFE_FAILURES.has(fallbackCode) ? fallbackCode : 'PROBE_VALIDATION';
    receipt.outputSha256 = createHash('sha256').update(JSON.stringify(state.treatments.map(t => ({ candidateId: t.candidateId, title: t.title, tagline: t.tagline, editorial: t.editorial })))).digest('hex');
  } catch (error) {
    receipt.failureCode = SAFE_FAILURES.has(error?.code) ? error.code : 'PROBE_VALIDATION';
  }
  if (contractFailure) receipt.failureCode = contractFailure;
  check('strict-structured-output-requested', receipt.requests.length > 0 && receipt.requests.every(r => r.strictSchemaRequested && Number.isInteger(r.requestedMaxTokens) && r.requestedMaxTokens > 0 && r.requestedMaxTokens <= (r.completionPhase === 'selection' ? 2400 : 1300)));
  check('maximum-two-requests', receipt.requests.length <= maxRequests && reservations <= maxRequests);
  receipt.requestCount = receipt.requests.length;
  receipt.finishedAt = new Date().toISOString();
  receipt.durationMs = Math.round(performance.now() - started);
  receipt.passed = !receipt.failureCode && receipt.checks.every(c => c.passed);
  receipt.verification = {
    authenticatedGroq: transport === 'live' && receipt.requests.some(r => r.httpStatus === 200),
    modelSelection: receipt.checks.some(c => c.id === 'two-model-actions-without-policy-fallback' && c.passed),
    creativeContract: receipt.checks.some(c => c.id === 'two-valid-model-proposals' && c.passed) && receipt.checks.some(c => c.id === 'proposal-action-form-not-factual-verification' && c.passed),
    realQloo: false, venueFacts: false
  };
  receipt.liveGroqVerified = transport === 'live' && receipt.passed;
  if (!receipt.passed && !receipt.failureCode) receipt.failureCode = 'PROBE_VALIDATION';
  if (JSON.stringify(receipt).includes(env.GROQ_API_KEY)) throw new Error('Receipt withheld because it contained a credential.');
  return receipt;
}

export async function writeReceipt(receipt, { root = ROOT, secrets = [] } = {}) {
  const output = JSON.stringify(receipt, null, 2) + '\n';
  if (secrets.some(secret => typeof secret === 'string' && secret.length && output.includes(secret))) throw new Error('Receipt withheld because it contained private configuration.');
  const directory = path.join(root, 'evidence');
  await mkdir(directory, { recursive: true });
  const stamp = receipt.startedAt.replaceAll(/[:.]/g, '-');
  const file = path.join(directory, `groq-validation-summary-${stamp}.json`);
  await writeFile(file, output, { mode: 0o600, flag: 'wx' });
  return file;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help || !options.executeLive) {
    console.log(JSON.stringify({
      mode: 'plan-only', networkRequests: 0,
      command: 'node scripts/validate-groq.mjs --execute-live --max-groq-requests 2',
      environment: ['GROQ_API_KEY'], optionalEnvironment: ['GROQ_MODEL=openai/gpt-oss-20b'],
      scope: 'Two Groq requests at most: discover then select with creative proposals. Candidates are fictional fixtures, not Qloo results. No runtime server is started or changed.',
      receipts: 'A sanitized evidence/groq-validation-summary-*.json stores checks, counts and an output hash. No key, prompt, creative text, reasoning or raw response is printed or saved.'
    }, null, 2));
    return;
  }
  const receipt = await validateGroq({ env: process.env, maxRequests: options.maxRequests });
  await writeReceipt(receipt, { secrets: [process.env.GROQ_API_KEY, process.env.QLOO_API_KEY] });
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = receipt.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Groq validation did not start or could not save a safe receipt. Check --help, explicit budget and server credentials. No raw diagnostics are printed.');
    process.exitCode = 1;
  });
}
