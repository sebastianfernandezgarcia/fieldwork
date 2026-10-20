# FIELDWORK

### From feeling to field.

A photographer gets a film, a record and a brand as references. FIELDWORK turns those starting points into a location shortlist and two editable creative directions. Keep the direction you agree on, rule out the other place, and carry the decision forward into a shoot brief.

[Open the demo](https://fieldwork-demo.onrender.com/) · [MIT license](LICENSE)

**Release status, 20 October:** two distinct briefs have completed the real Qloo workflow, including keep, veto/replacement and canonical export. The updated build is being prepared for deployment; the linked public demo still runs the earlier Sample release. This project has not been submitted to the hackathon.

## Try the working study

1. Choose a city and enter three cultural references: a film, an artist and a brand.
2. Scout the direction. Resolve an ambiguous reference if prompted.
3. Compare the proposed locations and open **See the reasoning** for the underlying evidence.
4. Keep one direction, edit its shot plan, then rule out the other location.
5. Review the replacement and download the current brief as Markdown or JSON.

Keep the demo brief fictional: its creative intent and candidate places are sent to Groq for planning. The interface identifies Sample and live data explicitly. A failed live request never silently becomes a Sample result.

## Why Qloo matters

Qloo connects cultural references to candidate places using its taste graph. FIELDWORK uses **Search** to identify the references, **Tags** to resolve supported place categories, and **Insights** to obtain candidate locations. The model chooses bounded actions over those observed candidates; it cannot invent a Qloo entity or write its own affinity score.

The shortlist remains explainable as it changes. Keeping a direction preserves its accepted text. A veto excludes that place from the next revision. Comparing taste and popularity order shows what the taste signals changed within the same candidate pool; it does not prove that a recommendation is objectively better.

| In the study | Where it comes from | What it means |
| --- | --- | --- |
| Entity identity, returned location data and affinity | Qloo in live mode | Cultural research, with source labels and raw scores |
| Narrative and shot ideas | Groq, or a visibly labelled authored fallback | Creative proposals to test on a scout |
| Permissions, access, opening hours and practical checks | The photographer | Unverified until someone checks them |
| Mood artwork | AI-generated illustrative assets | A creative reference, never a photograph of the recommended venue |

Cultural affinity does not verify visual similarity, good light, availability or permission to shoot. The practical checklist stays separate from the recommendations.

## How it works

```text
Brief + cultural references
        ↓
Resolve references → discover places → select creative directions
        ↓                  Qloo evidence + bounded Groq actions
Keep / edit / veto → revision with preserved decisions
        ↓
Current, editable shoot brief + provenance
```

The Node.js server owns canonical study state and validates all revisions and exports. The browser cannot manufacture evidence by changing its local copy. Groq uses strict structured outputs with observed candidate IDs, text bounds and explicit fallback records. The research trail contains observable actions and safe diagnostics, not private model reasoning.

Provider keys stay on the server. Requests are limited in one demo process, and no provider request runs automatically when the page opens. The optional [MCP integration](integrations/mcp) exposes the bounded workflow to an existing agent.

## Run locally

Use Node.js 20.11 or newer. The core app has no npm dependencies or build step.

```sh
npm start
```

Open `http://127.0.0.1:4322`. The default uses labelled fictional Sample places and a local policy, with no paid API calls.

For live use, supply `QLOO_API_KEY` and the exact `QLOO_API_BASE_URL` assigned with your key. Configure `FIELDWORK_PLANNER=groq`, `GROQ_MODEL=openai/gpt-oss-20b` and a server-only `GROQ_API_KEY` for the hosted planner. Load those credentials through your environment or host's secret settings. The app does not automatically load `.env` files. Never commit a filled environment file.

See [.env.example](.env.example), the [deployment guide](deploy/README.md) and [request limits](docs/REQUEST_BUDGET.md).

## Verification and limits

```sh
npm test
```

The offline suite checks reference resolution, candidate validation, keep/veto behavior, canonical revisions, creative output guards, export integrity and request budgets. Offline tests are distinct from authenticated provider checks; the [validation instructions](scripts/README.md) explain the bounded live verifier.

The [20 October integration receipt](evidence/qloo-groq-integration-2026-10-20T10-59-24-353Z.json) records two live Qloo briefs and ten passing workflow checks. The first brief and its replacement used model-proposed creative treatments. The second brief used visibly labelled authored treatments after the creative guard rejected the model output. This fallback preserves the real Qloo research; it does not turn it into Sample data. The controlled verifier paced model calls, so its duration is not a user-facing latency measurement.

Public-browser acceptance of the updated deployment remains pending. Historical Sample and Groq evidence is preserved in the [18 October validation history](docs/VALIDATION_HISTORY_2026-10-18.md). Successful checks establish their recorded cases, not general model reliability or verified venue conditions.

The public demo uses Render Free. It can sleep while inactive, and waking may take time. Server storage is temporary: if a saved study expires, FIELDWORK preserves creative notes and marks the research unverified until an explicit fresh scout. Download your brief to keep a copy.

This is a single-user demonstration with capability-based study IDs, not a production service for confidential client work. Production use would need authentication, durable storage and distributed quota controls. Provider Free plans remain the spending boundary.

## Project map

| Area | Purpose |
| --- | --- |
| `public/` | Creative workspace, decision journal and editable brief |
| `lib/` | Qloo adapter, planner, validated workflow and session storage |
| `tests/` | Controlled regression checks |
| `scripts/` | Opt-in provider validation with request ceilings |
| `evidence/` | Reviewed receipts, without keys or private provider bodies |
| `deploy/` | Hosting instructions and Free deployment configuration |

[API contract](API_CONTRACT.json) · [License](LICENSE)
