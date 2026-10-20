# Validation history · 18 October 2026

This is the archived README from the Sample release. It records historical observations and limitations; it is not the current status. See the [current README](../README.md) for the live integration status.

# FIELDWORK

Turn cultural references into an editorial location brief you can explain, revise and take on a scout. FIELDWORK helps an independent photographer compare two directions, preserve an agreed treatment and replace a rejected place without losing the rest of the work.

**Current status:** the [public Sample demo](https://fieldwork-demo.onrender.com/) is deployed on Render Free, with server-side Groq and fictional candidate places. The [source](https://github.com/sebastianfernandezgarcia/fieldwork) is public under MIT. Qloo access is still pending; real Qloo authentication and two live briefs remain unverified.

The public browser test generated two model proposals on one scout, preserved a kept treatment and an edited shot during a veto, and downloaded the edits in Markdown and JSON. Some earlier selections used an explicit policy fallback. An exact local replay reproduced one HTTP400 `json_validate_failed`: the response contained both proposals but omitted `usePreferences`, a field used only for discovery. The selection contract now contains only its three relevant fields; discovery still requires its boolean preference flag. Strict schemas, observed candidate IDs, preserved choices and the creative-output guard remain enforced. One authenticated after-fix replay of that exact context returned HTTP200 and two proposals accepted by the actual creative guard, with no fallback or retry. This verifies the reproduced case, not all future model outputs or Qloo. HTTP diagnostics stay in the research trail; provider bodies and messages are never published.

The subsequent hosted scout returned two model proposals with no policy fallback. Keeping one direction, editing its shot plan, replacing the alternative and exporting both formats preserved the accepted text and edits. The replacement selected a valid location but used an explicit authored creative fallback. A single replay of that veto context returned a 102-character tagline against the unchanged 100-character limit. The prompt now asks for 5–9 words targeting 70 characters. One authenticated after-change replay of the same selection context returned a 29-character tagline and a valid new proposal, preserving the accepted treatment exactly without a template fallback or retry. This supports that specific case on the published application code; it does not establish hosted reliability or validate Qloo. The runtime still rejects oversized text without truncation.

Free hosting can sleep when inactive and take time to wake. Its local session storage is temporary. Download your brief to retain a copy.

## Run locally

Use Node.js 20.11 or newer. The core app has no npm dependencies or build step.

```sh
npm start
```

Open `http://127.0.0.1:4322`. The default is labelled sample data and a bounded policy planner. No paid model or API is called by default.

```sh
npm test
```

## What to try

1. Open a sample brief and run the scout.
2. Compare the quiet and graphic treatments. Creative directions are authored proposals, not visual findings from Qloo. The shot plan is editable.
3. Lock the second treatment and reject the first. The fixed treatment keeps its content and position.
4. Change a reference. Fixed treatments require review because their evidence belongs to an earlier brief.
5. Export the current brief with source labels and unverified practical checks.

Try `Dune` as a movie reference to exercise disambiguation. Two film versions require a choice before scouting continues.

## Live Qloo

Keep `QLOO_API_KEY` in a server environment variable or your host's secret manager. Set `QLOO_API_BASE_URL` to the exact official endpoint assigned with the event credential. Never place keys in the browser, repository, exported brief, model prompt or recording. `.env.example` documents variables; the application does not automatically load `.env` files.

Select live data explicitly. Authentication, quota and timeout errors stop the run; sample results never silently replace Qloo. The adapter uses Search, Tags and Insights, confirming identities and category matches before sending their IDs to later requests.

Qloo Search represents an unmatched reference with HTTP 404; FIELDWORK asks for another reference without inventing a match. Category tags accept both official identifier shapes, respect place-type metadata when supplied and require one unambiguous exact match. Unconfirmed categories remain creative preferences. These compatibility paths are tested offline; they are not proof of authenticated Qloo access.

Qloo supplies aggregate cultural affinity. FIELDWORK does not claim that Qloo analyses a photo, understands a venue's light, predicts satisfaction or verifies permission. Scores stay raw. The comparison ranks the same candidates by taste and popularity; a ranking difference does not prove a better result.

## Optional local model

If Ollama is already running with an installed compatible model:

```sh
FIELDWORK_PLANNER=ollama OLLAMA_MODEL=your-installed-model npm start
```

This does not download a model. The planner asks the local model to choose valid tools and candidate IDs from observed results. Failed or invalid actions fall back to the bounded policy with explicit trace/provenance labels. Internal model reasoning is not recorded or shown.

The local model is a development path, not proof that a hosted demo can reach it. The optional [MCP integration](../integrations/mcp/) exposes the workflow to an existing agent and has its own package.

On 18 October, the existing local model `jevk5-4b-v0.3:q4_k_m` completed an initial scout, a locked-treatment revision and a sparse-result recovery: seven model-selected actions and zero policy fallbacks in that run. The provider used synthetic fixtures, not live Qloo. [Recorded tool trace](../evidence/local-agent-verified-2026-10-18.json). A separate Qwen probe fell back to the policy; that was not counted as model success.

## Optional hosted model and creative provenance

Set `FIELDWORK_PLANNER=groq`, `GROQ_MODEL=openai/gpt-oss-20b` and the server-only `GROQ_API_KEY` to use the Groq adapter. Confirm the intended account's free allowance before live use; do not enable paid billing for this demo.

On 18 October 2026, an initial authenticated check completed two Groq requests, both HTTP 200. The model selected both actions without policy fallback and returned two validated creative proposals. All eight initial-scout checks passed, including proposed-action language. [Initial-scout receipt](../evidence/groq-validation-summary-2026-10-18T10-49-02-444Z.json).

A later test used a copy of an existing fixture revision with one accepted treatment and an earlier veto. It vetoed the remaining alternative and made three real requests: discovery, preference relaxation and selection. All three actions succeeded, both rejected candidates were excluded, and the accepted treatment was preserved exactly. An initial response wrongly proposed rewriting the accepted candidate, so the creative-ID schema was restricted to unlocked candidates. A subsequent response returned one proposal for the new candidate, but its premise exceeded the text limit: `CREATIVE_TEXT_LIMIT` triggered an authored replacement. That check did **not** pass the complete creative workflow. [Historical failed replan](../evidence/groq-locked-replan-summary-2026-10-18T11-02-41-891Z.json).

The prompt now asks for one premise sentence of 18–28 words, targeting 200 characters, and one sentence per shot of 8–18 words, targeting 120 characters. It emphasizes subject actions and framing without assuming physical venue features. Runtime limits remain 320 and 180 characters; text is not truncated or retried.

After that change, one real browser veto/replan passed all seven checks: three Groq-selected actions, no policy fallback, the accepted treatment preserved exactly, both vetoes excluded and a new `model-proposed` alternative. Its premise measured 107 characters. The request count comes from successful action records, with one request per action and no retries; the browser receipt does not claim captured HTTP status codes. [Current browser-replan receipt](../evidence/groq-browser-replan-summary-2026-10-18.json). These exercises used fictional candidates and zero Qloo requests. They do not verify venue facts, real Qloo results or public hosting, and one successful response does not guarantee every future response will meet the contract.

That browser run also exposed a warning left over from the previous failed revision. The engine now refreshes operational warnings on each scout while preserving the trace and limitations of retained treatments. Offline regression tests cover failure followed by success; the original browser receipt remains unchanged.

With the credential already loaded privately into the environment, the opt-in check is:

```sh
node scripts/validate-groq.mjs --execute-live --max-groq-requests 2
```

It permits at most two requests and saves only checks, counts and an output hash. Without `--execute-live`, it makes no network requests. See [validation instructions](../scripts/README.md) for credential handling and the separate Qloo integration check.

The model selects a validated action and existing candidate IDs, then the engine executes its bounded tools. In the same selection response, it can propose two distinct portrait narratives and three shots for each. These ideas use the brief and cultural references; they must not assert a venue's light, architecture, permission, prices or other physical conditions. Fixed treatments retain their accepted text when a different place is replaced.

Every treatment labels its editorial source. `model-proposed` includes the provider and model; `authored-template` identifies the local fallback. Invalid creative text falls back independently, preserving valid model-selected locations and displaying a warning. Qloo evidence, practical checks and raw affinity are separate fields and cannot be supplied by a creative proposal.

A live review exposed a proposal that described unverified venue light and walls. The prompt now omits venue names and descriptions, includes a concrete counterexample, and asks for future shooting actions. A sentence-form check rejects descriptive premises and shot notes, including that observed failure. `editorial.validation` records `proposal-action-form-v1` with `factualVerification: false`: this is a limited language check, not a guarantee of truth or feasibility. The interface keeps an explicit scout-required notice beside creative text. Rejected proposals expose a safe failure code and use authored text; successful model proposals retain their separate source label.

Requests use [Groq strict structured outputs](https://console.groq.com/docs/structured-outputs), not vendor tool calling. Discovery has a two-field schema (`action`, `usePreferences`). Selection and relaxation use `action`, `candidateIds` and `creativeProposals`; the discovery-only flag is absent. Each phase rejects extra fields. Creative proposal IDs are limited to unlocked candidates, and the expected proposal count is explicit in the observation; the runtime still checks the complete response. Requests go only to the fixed official endpoint, do not follow redirects and have no automatic retries. Each planner instance permits at most four requests with 1,300 completion tokens each and a 15-second default timeout. Authentication, quota and response failures are recorded as explicit policy fallback. A shared deployment-budget rejection instead stops the run before transport. Keys, private model reasoning and provider error bodies are never included in the brief.

## Data and deployment boundaries

The CLI saves canonical briefs in `.local/sessions.json` for 48 hours, up to 120 briefs. Writes are atomic and private (0600); the directory is ignored by Git. Revisions use the server copy, so altered browser data cannot forge Qloo provenance. The local file allows continuation after restart. Treat run IDs as private capability links and keep real client information out of this prototype.

The server binds to `127.0.0.1`. Public hosting requires explicit `HOST` and `FIELDWORK_PUBLIC_ORIGIN`, server-side secrets and a demonstrated zero-cost operating plan. The [deployment instructions](../deploy/README.md) and [shared request limits](../docs/REQUEST_BUDGET.md) describe the prepared Free route. Production authentication and distributed quota protection are not included. Publication is a separate step.

The browser verifies restored studies and exports against canonical server state. If a session has expired, it preserves the brief and creative notes, marks the saved research as unverified and requires an explicit fresh scout. A Free host's ephemeral disk does not inherit the local file's restart continuity. There is no automatic provider request when reopening the page.

Entity images from Qloo remain marked with unverified display rights. Illustrative artwork must not appear to be a real image of a proposed venue.

API shapes: [API_CONTRACT.json](../API_CONTRACT.json). Current validation: [BACKEND_VALIDATION.md](../evidence/BACKEND_VALIDATION.md). Tests, local model evidence and future live Qloo evidence represent different levels of verification. This prototype is not a submitted entry.
