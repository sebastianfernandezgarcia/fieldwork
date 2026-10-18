import { AppError } from './errors.mjs';

export const DEFAULT_REQUEST_LIMITS = Object.freeze({
  qloo: Object.freeze({ minute: 20, day: 200 }),
  groq: Object.freeze({ minute: 10, day: 100 }),
  activeOperations: 2,
});

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const configurationError = () => new AppError('REQUEST_BUDGET_CONFIGURATION', 'The external request budget configuration is invalid. Live operations are disabled until it is corrected.', 503);

function lowerLimit(value, ceiling) {
  if (value === undefined) return ceiling;
  // Environment overrides must be explicit decimal integers. Blank, signed,
  // fractional and exponential values fail closed rather than restore defaults.
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw configurationError();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > ceiling) throw configurationError();
  return limit;
}

export function requestLimitsFromEnvironment(env = {}) {
  return {
    qloo: {
      minute: lowerLimit(env.FIELDWORK_QLOO_MAX_PER_MINUTE, DEFAULT_REQUEST_LIMITS.qloo.minute),
      day: lowerLimit(env.FIELDWORK_QLOO_MAX_PER_DAY, DEFAULT_REQUEST_LIMITS.qloo.day),
    },
    groq: {
      minute: lowerLimit(env.FIELDWORK_GROQ_MAX_PER_MINUTE, DEFAULT_REQUEST_LIMITS.groq.minute),
      day: lowerLimit(env.FIELDWORK_GROQ_MAX_PER_DAY, DEFAULT_REQUEST_LIMITS.groq.day),
    },
    activeOperations: lowerLimit(env.FIELDWORK_MAX_ACTIVE_OPERATIONS, DEFAULT_REQUEST_LIMITS.activeOperations),
  };
}

/**
 * Process-local backpressure, not a billing guarantee. Reserve synchronously
 * immediately before every provider fetch; failed fetches remain counted.
 * Provider hard caps are still required. Restarting this process resets usage.
 */
export function createRequestBudget({ env = process.env, now = () => Date.now() } = {}) {
  const limits = requestLimitsFromEnvironment(env);
  const history = { qloo: [], groq: [] };
  let activeOperations = 0;
  let lastTime = 0;

  function instant() {
    const value = now();
    if (!Number.isFinite(value) || value < 0) throw configurationError();
    // Wall-clock rollback must not make earlier requests expire prematurely.
    lastTime = Math.max(lastTime, value);
    return lastTime;
  }

  function counts(provider, at) {
    history[provider] = history[provider].filter(timestamp => timestamp > at - DAY_MS);
    return {
      minute: history[provider].filter(timestamp => timestamp > at - MINUTE_MS).length,
      day: history[provider].length,
    };
  }

  return {
    reserve({ provider } = {}) {
      if (!Object.hasOwn(history, provider)) throw configurationError();
      const at = instant();
      const used = counts(provider, at);
      const label = provider === 'qloo' ? 'Qloo' : 'Groq';
      for (const window of ['day', 'minute']) {
        if (used[window] >= limits[provider][window]) {
          throw new AppError('REQUEST_BUDGET_EXHAUSTED', `The demo has reached its ${label} request allowance for this ${window}. Please try again later.`, 429);
        }
      }
      // Both windows pass before committing a reservation. Array length cannot
      // exceed the day's ceiling, giving a maximum of 300 stored timestamps.
      history[provider].push(at);
    },

    acquire() {
      if (activeOperations >= limits.activeOperations) {
        throw new AppError('OPERATION_CAPACITY', 'The demo cannot start another expensive operation yet. Please try again shortly.', 429);
      }
      activeOperations++;
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        activeOperations--;
      };
    },

    snapshot() {
      const at = instant();
      return {
        scope: 'process-local; resets on restart; not a billing guarantee',
        activeOperations, maxActiveOperations: limits.activeOperations,
        providers: Object.fromEntries(['qloo', 'groq'].map(provider => [provider, {
          used: counts(provider, at), limits: { ...limits[provider] },
        }])),
      };
    },
  };
}
