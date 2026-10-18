import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { QlooProvider } from '../lib/qloo.mjs';
import { exampleById } from '../lib/engine.mjs';
import { validateBrief } from '../lib/validation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_REQUESTS = 24;
const SAFE_ERROR_CODES = new Set([
  'QLOO_NOT_CONFIGURED', 'QLOO_CONFIGURATION', 'QLOO_TIMEOUT', 'QLOO_UPSTREAM',
  'QLOO_AUTH', 'QLOO_RATE_LIMIT', 'QLOO_CONTRACT', 'TOOL_BUDGET', 'VALIDATION',
  'PLANNER_CONTRACT', 'RATE_LIMIT', 'BRIEF_NEEDS_REVIEW', 'STALE_REVISION',
  'REQUEST_BUDGET_EXHAUSTED', 'OPERATION_CAPACITY', 'PLANNER_CONFIGURATION',
]);

export const defaultBriefs = () => [exampleById('quiet-city'), exampleById('slow-city')];

export function parseOptions(args) {
  const options = { executeLive: false, maxRequests: null, briefsPath: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute-live') options.executeLive = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--max-qloo-requests') options.maxRequests = Number(args[++i]);
    else if (arg === '--briefs') options.briefsPath = args[++i];
    else throw new Error('Unknown option. Use --help.');
  }
  if (options.maxRequests !== null && (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > MAX_REQUESTS)) {
    throw new Error(`The request budget must be an integer from 1 to ${MAX_REQUESTS}.`);
  }
  if (options.executeLive && options.maxRequests === null) throw new Error('Live validation requires an explicit --max-qloo-requests budget.');
  if (options.briefsPath !== null && !options.briefsPath) throw new Error('--briefs requires a local JSON path.');
  return options;
}

function validationError(code) {
  return Object.assign(new Error('Validation stopped. See the redacted summary.'), { code });
}

const safeCode = error => SAFE_ERROR_CODES.has(error?.code) ? error.code : 'VALIDATION_STOPPED';
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// This starts the actual application's HTTP handler on an ephemeral loopback port.
// Only the Qloo transport is wrapped, to enforce a global budget across revisions.
export async function validateLive({
  env, maxRequests, briefs = defaultBriefs(), qlooFetch = fetch,
  transport = 'live', plannerFactory,
} = {}) {
  if (!env?.QLOO_API_KEY || !env?.QLOO_API_BASE_URL) {
    throw new Error('Set QLOO_API_KEY and the exact QLOO_API_BASE_URL assigned with the credential.');
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_REQUESTS) throw new Error('Choose a request budget between 1 and 24.');
  if (!['live', 'simulation'].includes(transport)) throw new Error('Unknown transport.');
  if (!Array.isArray(briefs) || briefs.length !== 2) throw new Error('Provide exactly two synthetic or public-reference briefs.');
  briefs = briefs.map(validateBrief);
  // Validate the credential destination before opening any socket.
  new QlooProvider({ apiKey: env.QLOO_API_KEY, baseUrl: env.QLOO_API_BASE_URL });
  const started = performance.now();
  const receipt = {
    schemaVersion: 'fieldwork.live-validation.v1', startedAt: new Date().toISOString(),
    transport, requestBudget: maxRequests, requests: [], steps: [], states: [], checks: [],
    note: 'No raw upstream response, request header, credential or private model reasoning is stored.',
  };
  let budgetExhausted = false;
  const addCheck = (id, passed) => receipt.checks.push({ id, passed: Boolean(passed) });
  const boundedFetch = async (url, options) => {
    if (receipt.requests.length >= maxRequests) {
      budgetExhausted = true;
      throw validationError('TOOL_BUDGET');
    }
    const item = { index: receipt.requests.length + 1, endpoint: new URL(url).pathname, status: null, durationMs: null };
    receipt.requests.push(item);
    const begin = performance.now();
    try {
      const response = await qlooFetch(url, options);
      item.status = response.status;
      return response;
    } finally { item.durationMs = Math.round(performance.now() - begin); }
  };
  const server = createApp({
    env, sessionPath: null, plannerFactory,
    providerFactory(mode, config) {
      if (mode !== 'live') throw validationError('VALIDATION');
      return new QlooProvider({ apiKey: env.QLOO_API_KEY, baseUrl: env.QLOO_API_BASE_URL, beforeRequest: config.beforeRequest, fetchImpl: boundedFetch, maxRequests: 10 });
    },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (label, route, body, expectedStatus = 200) => {
    const response = await fetch(base + route, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : {});
    const text = await response.text();
    if (text.includes(env.QLOO_API_KEY)) throw validationError('QLOO_CONTRACT');
    let data;
    try { data = JSON.parse(text); } catch { throw validationError('QLOO_CONTRACT'); }
    const step = { label, httpStatus: response.status, expectedStatus, success: response.status === expectedStatus };
    if (data?.error?.code) step.errorCode = safeCode(data.error);
    receipt.steps.push(step);
    if (!step.success) throw validationError(step.errorCode || 'VALIDATION_STOPPED');
    return data;
  };
  try {
    const created = [];
    for (let i = 0; i < briefs.length; i++) {
      const state = await request(`brief-${i + 1}`, '/api/rehearse', { brief: briefs[i], dataMode: 'live' });
      receipt.states.push({ label: `brief-${i + 1}`, state });
      created.push(state);
      addCheck(`brief-${i + 1}-ready`, state.status === 'ready' && state.treatments.length === 2);
      addCheck(`brief-${i + 1}-qloo-source`, state.dataMode === 'live' && state.provenance.qlooUsed && state.resolvedReferences.length > 0 && state.resolvedReferences.every(r => r.source === 'qloo') && state.candidates.length > 0 && state.candidates.every(c => c.source === 'qloo' && !c.id.startsWith('sample:')));
    }
    let state = created[0];
    if (state.status === 'ready' && state.treatments.length === 2) {
      const keepId = state.treatments[0].id;
      const vetoId = state.treatments[1].candidateId;
      const beforeLockRequests = receipt.requests.length;
      state = await request('lock-first-treatment', '/api/revise', {
        state: { runId: state.runId, revision: state.revision }, action: { type: 'lock', targetId: keepId },
        briefEdits: { title: 'A record sleeve, one decision kept', note: 'Synthetic validation: retain this direction and find a different second setting.' },
      });
      const fixed = structuredClone(state.treatments.find(t => t.id === keepId));
      receipt.states.push({ label: 'locked', state });
      addCheck('lock-needs-no-qloo-request', receipt.requests.length === beforeLockRequests && fixed?.locked);
      const staleRevision = state.revision;
      state = await request('veto-and-replan', '/api/revise', {
        state: { runId: state.runId, revision: state.revision }, action: { type: 'veto', targetId: vetoId, reason: 'Synthetic validation: the second setting is unavailable.' },
      });
      receipt.states.push({ label: 'replanned', state });
      addCheck('replan-ready', state.status === 'ready' && state.treatments.length === 2);
      addCheck('locked-treatment-preserved', same(fixed, state.treatments.find(t => t.id === keepId)));
      addCheck('veto-excluded', state.brief.avoidEntityIds.includes(vetoId) && !state.candidates.some(c => c.id === vetoId) && !state.treatments.some(t => t.candidateId === vetoId));
      const exported = await request('canonical-export', `/api/briefs/${state.runId}/export`);
      addCheck('export-matches-canonical-revision', same(exported, state));
      const stale = await request('reject-stale-revision', '/api/revise', {
        state: { runId: state.runId, revision: staleRevision }, action: { type: 'unlock', targetId: keepId },
      }, 409);
      addCheck('stale-revision-rejected', stale.error?.code === 'STALE_REVISION');
    } else {
      addCheck('replan-ready', false);
      receipt.failureCode = state.status === 'needs_input' ? 'REFERENCE_CHOICE_REQUIRED' : 'COVERAGE_INSUFFICIENT';
    }
  } catch (error) {
    receipt.failureCode = budgetExhausted ? 'GLOBAL_QLOO_BUDGET' : safeCode(error);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.durationMs = Math.round(performance.now() - started);
  receipt.requestCount = receipt.requests.length;
  receipt.passed = !receipt.failureCode && receipt.checks.length >= 10 && receipt.checks.every(c => c.passed);
  return receipt;
}

export function publicSummary(receipt) {
  return {
    schemaVersion: 'fieldwork.live-validation-summary.v1',
    startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
    transport: receipt.transport,
    liveQlooVerified: receipt.transport === 'live' && receipt.passed,
    passed: receipt.passed, failureCode: receipt.failureCode ?? null,
    requestBudget: receipt.requestBudget, requestCount: receipt.requestCount, durationMs: receipt.durationMs,
    checks: receipt.checks,
    briefs: receipt.states.filter(s => /^brief-\d$/.test(s.label)).map(({ label, state }) => ({
      label, status: state.status, referencesResolved: state.resolvedReferences.length,
      candidates: state.candidates.length, treatments: state.treatments.length,
      referenceChoicesNeeded: state.resolutionIssues.length,
      planner: ['bounded-policy-v1', 'local-ollama', 'local-ollama-with-policy-fallback', 'groq', 'groq-with-policy-fallback'].includes(state.provenance.planner) ? state.provenance.planner : 'other',
      modelActions: state.provenance.modelActions ?? 0, policyActions: state.provenance.policyActions ?? 0,
      rankingComparisonAvailable: Boolean(state.comparison?.available),
    })),
    scope: 'Two synthetic briefs through the real application HTTP routes; keep, veto/replan, canonical export and stale-revision rejection. This does not verify venue permission, visual suitability, admission fees, production availability, public hosting or competition eligibility.',
  };
}

export async function writeReceipts(receipt, { root = ROOT, secrets = [] } = {}) {
  const stamp = receipt.startedAt.replaceAll(/[:.]/g, '-');
  const directory = path.join(root, 'evidence', 'private', 'live-validation');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(path.join(root, 'evidence', 'private'), 0o700);
  await chmod(directory, 0o700);
  let privateText = JSON.stringify(receipt, null, 2) + '\n';
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length)) privateText = privateText.split(secret).join('[REDACTED]');
  const privatePath = path.join(directory, `${stamp}.json`);
  await writeFile(privatePath, privateText, { mode: 0o600, flag: 'wx' });
  const summary = publicSummary(receipt);
  summary.privateReceiptSha256 = createHash('sha256').update(privateText).digest('hex');
  const publicPath = path.join(root, 'evidence', `live-validation-summary-${stamp}.json`);
  await writeFile(publicPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  return { summary, privatePath, publicPath };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help || !options.executeLive) {
    console.log(JSON.stringify({
      mode: 'plan-only', networkRequests: 0,
      command: 'node scripts/validate-live.mjs --execute-live --max-qloo-requests 20',
      environment: ['QLOO_API_KEY', 'QLOO_API_BASE_URL'],
      optionalEnvironment: ['FIELDWORK_PLANNER=ollama|groq', 'OLLAMA_MODEL', 'GROQ_API_KEY', 'GROQ_MODEL'],
      optionalInput: '--briefs path/to/two-synthetic-briefs.json',
      scope: 'Two briefs, then keep/veto/replan, canonical export and stale-revision rejection through an ephemeral instance of the application. No retries, no fallback to fixtures. Live calls require explicit execution and budget flags.',
      receipts: 'Normalized states remain in ignored evidence/private/ with mode 0600. A separate summary contains only checks, counts and provenance.',
    }, null, 2));
    return;
  }
  const briefs = options.briefsPath ? JSON.parse(await readFile(options.briefsPath, 'utf8')) : defaultBriefs();
  const receipt = await validateLive({ env: process.env, maxRequests: options.maxRequests, briefs });
  const { summary } = await writeReceipts(receipt, { secrets: [process.env.QLOO_API_KEY, process.env.GROQ_API_KEY] });
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = receipt.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Validation did not start or could not save its receipt. Check --help, explicit budget, synthetic brief input and server environment. No credentials or raw diagnostics are printed.');
    process.exitCode = 1;
  });
}
