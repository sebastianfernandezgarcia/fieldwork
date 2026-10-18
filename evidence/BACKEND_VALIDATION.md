# Initial backend validation, 18 October 2026

This receipt records the initial overnight baseline. The local application completes the sample workflow and the optional local model performed real tool selection. Later Groq, recovery and quota changes have their own tests; run `npm test` for the current suite. Qloo access and public hosting remain unverified.

## Evidence

| Check | Observed result | Receipt |
|---|---|---|
| Core, provider boundary and HTTP regression suite | 29 tests passed, 0 failed | [TAP](backend-tests-2026-10-18.tap) |
| Local agent, initial scout | Two valid model actions, no fallback | [Trace](local-agent-verified-2026-10-18.json) |
| Local agent, lock second / reject first | Fixed treatment preserved byte-for-byte; rejected venue excluded | Same trace |
| Local agent, insufficient category results | Chose relaxation, observed new candidates, selected treatments | Same trace |
| Whole local-agent exercise | Seven model actions, zero fallback; about 3.8 seconds with a warm model | Same trace |
| Qwen probe | Policy fallback, explicitly labelled; not a model success | Private earlier probe, excluded from the source package |
| Canonical continuity after restart | Temporary session file reopened and revised to revision 2; file permissions 0600 | Regression test |
| Client-state tampering | Fake live mode, candidate and Qloo provenance ignored | Regression test |
| Upstream secrets and errors | Credential echo withheld; error bodies redacted; no sample substitution | Regression test |
| Narrow source scan | 17 backend/docs/receipt files inspected; no matches for tested credential patterns | Local scan, 18 October |

The source scan excluded `public/`, `integrations/`, `.local/` and `node_modules/`. It is not a complete publication audit. The tests use controlled responses, not an event credential. Local model evidence uses fixtures with fictional venues and null scores. The local model was `jevk5-4b-v0.3:q4_k_m` served by the already installed Ollama instance; no download or paid model call occurred.

## Reviewable work units

1. Brief state, reference resolution, fixed decisions and bounded tool planning, with engine tests.
2. Qloo HTTP boundary, query normalization, source separation and error handling, with provider tests.
3. HTTP API, canonical session state, atomic local persistence and request protection, with server tests.
4. Optional local-model planner with validated actions, explicit fallback and recorded real execution.

These are uncommitted work units. The workspace has no Git repository at this directory. The rollback boundary is `lib/`, `server.mjs`, `tests/`, `package.json`, `.env.example` and the backend API contract. The frontend in `public/` and optional MCP package in `integrations/` were handled separately and are not removed by a backend rollback. Preserve `.local/` if retaining local briefs is desired.

## Still needed before presentation

- An individually assigned event Qloo credential, quota and expiry, followed by live Search/Tags/Insights evidence.
- A comparison made with real Qloo affinity and popularity values; the current fixture view correctly reports it unavailable.
- A free public hosting plan that supports the demonstrated agent path and keeps server credentials private.
- A complete asset/license/privacy review and end-to-end browser acceptance on the final build.
- Separate registration and publication decisions. No registration, access request, organization message or publication was performed by this backend work.
