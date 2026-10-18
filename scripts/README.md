# Bounded integration checks

## Groq planner with fictional candidates

The initial authenticated Groq scout passed on 18 October 2026: two requests returned HTTP 200, both model actions ran without policy fallback, and two creative proposals passed the application contract and proposed-action language check. All eight initial-scout checks passed. [Initial-scout receipt](../evidence/groq-validation-summary-2026-10-18T10-49-02-444Z.json).

A later bounded diagnostic exercised the next veto/replan on an in-memory copy of an existing fixture revision 3, which already contained a locked model treatment and an earlier veto. Three requests returned HTTP 200: discovery, relaxation and selection. The locked treatment survived exactly and both vetoes were respected. Creativity did not pass. After restricting proposal IDs to unlocked candidates, the model returned the correct single proposal, but its premise exceeded the text limit, producing `CREATIVE_TEXT_LIMIT` and a visible authored fallback. [Historical failed replan](../evidence/groq-locked-replan-summary-2026-10-18T11-02-41-891Z.json). Its separate `verification` flags distinguish successful authentication, model actions and lock preservation from failed creative validation. It does not represent a rerun of the initial scout or a full workflow pass.

The prompt now requests exactly one short sentence per premise and shot: 18–28 words targeting 200 characters for the premise, and 8–18 words targeting 120 characters for a shot. Runtime limits remain 320/180 characters, with no truncation or retries.

One subsequent browser veto/replan passed all seven checks on the same fixture revision: three model-selected actions, no policy fallback, the accepted treatment preserved exactly, both vetoes respected, and a validated new creative proposal with a 107-character premise. [Current browser-replan receipt](../evidence/groq-browser-replan-summary-2026-10-18.json). Its three-request count is inferred from three successful action records and the adapter's one-request-per-action behavior; this receipt contains no captured HTTP status codes. A successful sample does not guarantee future compliance or factual accuracy. The command below covers only the initial scout, not this browser exercise.

The receipt also records a stale warning from the prior revision. A later state fix refreshes operational warnings when scouting again, retaining trace history and limitations of locked treatments. Offline failure-to-success regressions verify that correction without another provider call; the historical receipt was not rewritten.

This check uses a public-reference brief and fictional candidates from `FixtureProvider`. It records `syntheticCandidates: true`, `liveGroqVerified: true` only after a successful real run, and always `liveQlooVerified: false` with zero Qloo requests. It does not prove venue facts, real Qloo integration or public hosting.

Version 2 separates authenticated access, model selection and the creative contract in `verification`; a successful HTTP response alone does not pass all three. `creativeFailureCodes` contains only fixed diagnostic codes for invalid bindings, length/count limits, proposal language or structure. The language check verifies proposed-action form, not factual accuracy. A diagnostic run that used authored fallback failed the creative checks before the final passing run; it was not reported as creative success.

Inspect the plan and run its offline tests without making model requests:

```sh
node scripts/validate-groq.mjs
node --test scripts/validate-groq.test.mjs
```

To execute, first load the dedicated `GROQ_API_KEY` privately into the process environment and confirm the account's free allowance. The optional `GROQ_MODEL` must be `openai/gpt-oss-20b`. Never include the credential in a command argument, source file, screenshot or receipt. The script does not automatically read a `.env` file.

```sh
node scripts/validate-groq.mjs --execute-live --max-groq-requests 2
```

The explicit budget accepts 1 or 2 requests; the complete check needs two. The same planner and engine used by FIELDWORK execute discovery followed by selection with creative proposals. No runtime server is started, changed or restarted. There are no retries or Qloo calls.

Console output and `evidence/groq-validation-summary-<timestamp>.json` contain only fixed metadata, checks, counts, safe timing/status records and a hash of normalized output. Credentials, prompts, creative text, raw provider responses and private model reasoning are neither printed nor saved. Receipt files use mode 0600. Offline test receipts identify `transport: "simulation"` and never claim authenticated Groq verification. Exit code 0 means all checks passed; an incomplete or failed run exits 1.

## Qloo integration through the application

The validator exercises the same HTTP handler, canonical session logic, Qloo adapter and planner as FIELDWORK. It starts a temporary loopback instance with memory-only sessions, so it does not edit the open app's briefs or restart its server. It does not publish anything.

Run the simulator first:

```sh
node --test scripts/validate-live.test.mjs
node scripts/validate-live.mjs
```

The second command only prints the plan. It makes no network requests and does not inspect or print a credential.

After the account owner has authorized the access and Qloo has assigned an event credential, load `QLOO_API_KEY` and the exact assigned `QLOO_API_BASE_URL` into the process environment using your private local configuration. Do not put a key into a command argument, source file, screenshot, commit or receipt. The validator does not guess a different endpoint or read a `.env` file automatically.

```sh
node scripts/validate-live.mjs --execute-live --max-qloo-requests 20
```

The global budget counts every dispatched Qloo request across both briefs and the revision. It is mandatory, accepts 1–24 calls, stops before the next request would exceed it, and never retries. Eighteen calls is the expected path for the default briefs; category relaxation can require more. A small budget is useful for an explicit diagnostic run but will not count as a complete validation.

The checks cover two synthetic photographic briefs; explicit live provenance; a kept direction preserved exactly through a veto and replan; rejection of the excluded place; canonical JSON export; and rejection of an old revision. Live mode never substitutes fixtures. Unknown references remain a choice for the user. For confirmed entity IDs, provide exactly two complete brief objects in a private local JSON array with `--briefs path/to/two-synthetic-briefs.json`; each reference can include its confirmed `entityId`. Do not use client or personal information in validation briefs.

`FIELDWORK_PLANNER=ollama` and `OLLAMA_MODEL` select the existing local planner just as they do in the app. A successful Qloo validation is not proof that the local model ran: the summary separately reports model and fallback-policy actions. The local Ollama service must already be available; this script downloads no model.

For the hosted path, use `FIELDWORK_PLANNER=groq`, `GROQ_MODEL=openai/gpt-oss-20b` and the private server `GROQ_API_KEY`. The summary distinguishes Groq, mixed execution and policy fallback. The application's shared provider quotas remain active in addition to this CLI's total Qloo budget.

Receipts are written in two layers:

| File | Contents |
| --- | --- |
| `evidence/private/live-validation/<timestamp>.json` | Normalized run states, candidate IDs, safe endpoint/status/timing records. Ignored by Git; directory mode 0700 and file mode 0600. No raw upstream responses, request headers or model reasoning. |
| `evidence/live-validation-summary-<timestamp>.json` | Redacted counts, check outcomes, planner provenance and SHA-256 of the private receipt. No candidate names, IDs, queries, local file paths or credentials. |

A simulator receipt always has `transport: "simulation"` and `liveQlooVerified: false`, even when all functional checks pass. A real receipt is final integration evidence only when its checks pass with `transport: "live"`; venue photography permission, visual suitability, fees, availability, public hosting and competition eligibility still require their own checks.

The CLI exits 0 for a completed passing run and 1 for an incomplete or failed run. Console output is the same redacted summary. Configuration failures print one fixed sentence, never an environment dump or raw error stack.
