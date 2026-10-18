# Request limits for a small public demo

`lib/request-budget.mjs` provides one shared guard for the server process. `server.mjs` creates it once, passes its reservation hook to Qloo and Groq, and wraps searches, scouts and replans in a lease released from `finally`:

```js
const release = guard.acquire();
try {
  // Execute one scout or replan; provider hooks reserve each outgoing request.
} finally {
  release();
}
```

Reading a brief, keeping or releasing a treatment, and purely local policy operations do not need an external-request reservation. An operation lease does not itself consume provider quota. The Qloo hook runs outside its transport error handler, so a budget rejection reaches the client as a safe HTTP 429 rather than being reported as an upstream outage.

| Environment variable | Default and ceiling |
| --- | ---: |
| `FIELDWORK_QLOO_MAX_PER_MINUTE` | 20 |
| `FIELDWORK_QLOO_MAX_PER_DAY` | 200 |
| `FIELDWORK_GROQ_MAX_PER_MINUTE` | 10 |
| `FIELDWORK_GROQ_MAX_PER_DAY` | 100 |
| `FIELDWORK_MAX_ACTIVE_OPERATIONS` | 2 |

Omit a variable to use its default. Overrides can only lower these ceilings. A literal `0` disables the corresponding allowance; blank, negative, fractional, exponential, nonnumeric or above-ceiling values fail closed with `REQUEST_BUDGET_CONFIGURATION`. Do not include blank budget variables in an environment template.

The minute and day counters are exact rolling windows of 60 seconds and 24 hours. Reservations happen synchronously immediately before dispatch; failed upstream calls remain counted. A refused reservation does not enter history. There are no retries or reservations that can be refunded later. At most 300 timestamps are retained across both providers, regardless of the number of rejected attempts. Clock rollback does not release reservations early.

Two operations may hold leases concurrently by default. Each release function is idempotent, so cleanup cannot decrement the active count twice. Both `REQUEST_BUDGET_EXHAUSTED` and `OPERATION_CAPACITY` produce safe, human-readable 429 responses.

These counters are **process-local and reset when the server restarts**. Multiple server instances would each have their own allowance. They protect a small demo from bursts; they are not a billing guarantee, provider quota proof or durable global ledger. A zero-cost deployment still depends on provider-side free-plan limits, hard spending caps and the account's billing configuration. `snapshot()` reports only counters and configured limits, with that scope stated explicitly.

Verification: `node --test tests/request-budget.test.mjs tests/qloo.test.mjs tests/server.test.mjs`. The HTTP tests cover a quota shared across fresh provider instances, concurrent scouts, release after an upstream failure, and continued access to sample decisions and exports when expensive operations are disabled. All tests use a fake clock or simulated transport; they do not call Qloo or Groq.
