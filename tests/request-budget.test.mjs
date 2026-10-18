import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestBudget, requestLimitsFromEnvironment } from '../lib/request-budget.mjs';
import { publicError } from '../lib/errors.mjs';

test('defaults are conservative; overrides can only lower them and malformed values fail closed', () => {
  assert.deepEqual(requestLimitsFromEnvironment(), { qloo: { minute: 20, day: 200 }, groq: { minute: 10, day: 100 }, activeOperations: 2 });
  assert.deepEqual(requestLimitsFromEnvironment({ FIELDWORK_QLOO_MAX_PER_MINUTE: '4', FIELDWORK_GROQ_MAX_PER_DAY: '0', FIELDWORK_MAX_ACTIVE_OPERATIONS: '1' }), {
    qloo: { minute: 4, day: 200 }, groq: { minute: 10, day: 0 }, activeOperations: 1,
  });
  for (const value of ['', ' ', '-1', '+1', '1.0', '1e1', 'Infinity', 'NaN', '21', '9007199254740993', 1, null]) {
    assert.throws(() => createRequestBudget({ env: { FIELDWORK_QLOO_MAX_PER_MINUTE: value } }), { code: 'REQUEST_BUDGET_CONFIGURATION', status: 503 });
  }
  assert.throws(() => createRequestBudget({ env: { FIELDWORK_MAX_ACTIVE_OPERATIONS: '3' } }), { code: 'REQUEST_BUDGET_CONFIGURATION' });
});

test('rolling minute reservations are synchronous and independent by provider', () => {
  let time = 0;
  const budget = createRequestBudget({ env: { FIELDWORK_QLOO_MAX_PER_MINUTE: '2' }, now: () => time });
  budget.reserve({ provider: 'qloo', operation: 'search' });
  time = 30_000;
  budget.reserve({ provider: 'qloo', operation: 'insights' });
  assert.throws(() => budget.reserve({ provider: 'qloo' }), { code: 'REQUEST_BUDGET_EXHAUSTED', status: 429 });
  budget.reserve({ provider: 'groq', operation: 'chat' });
  assert.deepEqual(budget.snapshot().providers.qloo.used, { minute: 2, day: 2 });
  time = 60_000;
  budget.reserve({ provider: 'qloo' });
  assert.deepEqual(budget.snapshot().providers.qloo.used, { minute: 2, day: 3 });
  assert.equal(budget.snapshot().providers.groq.used.day, 1);
});

test('rolling day cap remains after a minute clears and expires at the exact boundary', () => {
  let time = 0;
  const budget = createRequestBudget({ env: { FIELDWORK_QLOO_MAX_PER_DAY: '2' }, now: () => time });
  budget.reserve({ provider: 'qloo' });
  time = 60_000;
  budget.reserve({ provider: 'qloo' });
  time = 120_000;
  assert.throws(() => budget.reserve({ provider: 'qloo' }), { code: 'REQUEST_BUDGET_EXHAUSTED' });
  assert.deepEqual(budget.snapshot().providers.qloo.used, { minute: 0, day: 2 });
  time = 86_400_000;
  budget.reserve({ provider: 'qloo' });
  assert.deepEqual(budget.snapshot().providers.qloo.used, { minute: 1, day: 2 });
});

test('zero allowance disables requests and invalid providers or clocks fail safely', () => {
  const budget = createRequestBudget({ env: { FIELDWORK_GROQ_MAX_PER_DAY: '0', FIELDWORK_QLOO_MAX_PER_MINUTE: '0' }, now: () => 0 });
  for (const provider of ['qloo', 'groq']) assert.throws(() => budget.reserve({ provider }), { code: 'REQUEST_BUDGET_EXHAUSTED' });
  for (const provider of ['constructor', '__proto__', 'unknown', undefined]) assert.throws(() => budget.reserve({ provider }), { code: 'REQUEST_BUDGET_CONFIGURATION' });
  assert.equal(budget.snapshot().providers.qloo.used.day, 0);
  for (const invalid of [NaN, Infinity, -1, '100']) assert.throws(() => createRequestBudget({ env: {}, now: () => invalid }).reserve({ provider: 'qloo' }), { code: 'REQUEST_BUDGET_CONFIGURATION' });
});

test('clock rollback does not release a budget early and failed reservations do not inflate memory', () => {
  let time = 100_000;
  const budget = createRequestBudget({ env: { FIELDWORK_QLOO_MAX_PER_MINUTE: '1' }, now: () => time });
  budget.reserve({ provider: 'qloo' });
  time = 1_000;
  for (let i = 0; i < 100; i++) assert.throws(() => budget.reserve({ provider: 'qloo' }), { code: 'REQUEST_BUDGET_EXHAUSTED' });
  assert.deepEqual(budget.snapshot().providers.qloo.used, { minute: 1, day: 1 });
  time = 160_000;
  budget.reserve({ provider: 'qloo' });
  assert.equal(budget.snapshot().providers.qloo.used.day, 2);
});

test('two expensive-operation leases enforce concurrency and release is idempotent', () => {
  const budget = createRequestBudget({ env: {} });
  const first = budget.acquire();
  const second = budget.acquire();
  assert.throws(() => budget.acquire(), { code: 'OPERATION_CAPACITY', status: 429 });
  first(); first();
  assert.equal(budget.snapshot().activeOperations, 1);
  const third = budget.acquire();
  second(); third(); third();
  assert.equal(budget.snapshot().activeOperations, 0);
  assert.equal(budget.snapshot().providers.qloo.used.day, 0);
  assert.equal(budget.snapshot().providers.groq.used.day, 0);
  assert.throws(() => createRequestBudget({ env: { FIELDWORK_MAX_ACTIVE_OPERATIONS: '0' } }).acquire(), { code: 'OPERATION_CAPACITY' });
});

test('quota errors are safe public 429 responses with no caller-supplied operation text', () => {
  const budget = createRequestBudget({ env: { FIELDWORK_GROQ_MAX_PER_DAY: '0' } });
  try {
    budget.reserve({ provider: 'groq', operation: 'private-context-secret' });
    assert.fail('expected a quota error');
  } catch (error) {
    const safe = publicError(error);
    assert.equal(safe.status, 429);
    assert.ok(safe.body.error.message.includes('Groq'));
    assert.ok(!JSON.stringify(safe).includes('private-context-secret'));
  }
});
