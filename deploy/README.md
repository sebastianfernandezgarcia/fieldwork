# Deploy FIELDWORK as a small public demo

FIELDWORK can run on one Render Free web service from a dedicated public repository. The instructions and supplied blueprint are deployment preparation, not a receipt for a hosted service. Validate both Qloo and the hosted model before describing a deployment as a working live demo.

## Create a service from a public repository

1. Publish only the audited source bundle in a dedicated repository with this application at its root. In Render, create a Web Service using its public Git repository URL. This route does not require connecting an account with access to other repositories.
2. Choose the Node runtime and Free instance, and keep one instance. Deployments through the public-URL route are manual. Verify that the workspace has no payment method or paid extras. Review the provider's current plan before creating a resource.
3. Use the settings below, then add the provider secrets before creating the service.

| Setting | Value |
| --- | --- |
| Build command | `node --check server.mjs` |
| Start command | `FIELDWORK_PUBLIC_ORIGIN="$RENDER_EXTERNAL_URL" node server.mjs` |
| Health check path | `/api/health` |
| `NODE_VERSION` | `24` |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `FIELDWORK_PLANNER` | `groq` |
| `GROQ_MODEL` | `openai/gpt-oss-20b` |

Render supplies `RENDER_EXTERNAL_URL` as the service's full HTTPS `onrender.com` URL at runtime. The start command assigns that value to FIELDWORK's allowed origin. Enter it as the start command, including the quoted variable; do not enter `$RENDER_EXTERNAL_URL` as a literal environment setting. A custom domain requires changing the allowed origin to that domain's actual HTTPS origin.

Add `QLOO_API_KEY`, the exact `QLOO_API_BASE_URL` assigned to the event credential, and a dedicated `GROQ_API_KEY` through the host's secret settings. Event credentials may use a different endpoint from production credentials; retain the assigned pairing. Keep the Groq project on Free and restrict it to the intended model. Leave `FIELDWORK_DEFAULT_MODE` unset until live verification passes; then `live` can select the live mode initially without automatically running queries.

## Blueprint alternative

For a Blueprint deployment, select `deploy/render-free.yaml` explicitly. It uses `node server.mjs` and asks for `FIELDWORK_PUBLIC_ORIGIN` through the environment settings. Supply the actual assigned HTTPS origin without a path. The manual route above instead resolves the assigned origin in its start command. Both routes require the same Free plan and provider-secret checks.

Do not put filled environment files or Qloo response bodies in the repository. Public evidence uses fixed metadata and checks, while private provider diagnostics stay outside the source bundle. The optional Dockerfile copies only runtime code and permitted public assets. Build it from the application root with `docker build -f deploy/Dockerfile .`; it is not required by either native Node route.

## Verify the release

- Check `/api/health` reports the intended planner and configured providers. Configuration alone is not proof of a successful API call.
- Follow [the bounded live verifier](../scripts/README.md) with an appropriate request allowance. Keep its private result files out of the repository.
- In a fresh browser, complete a live brief, retain one treatment, replace the other and export the current revision. Check the evidence panel for actual model actions and any fallback.
- Restart the service and reopen a saved study. The browser must preserve creative notes while marking missing server evidence as unverified. Re-scout only through an explicit user action.

## Limits of the Free deployment

Render Free sleeps after inactivity and uses ephemeral storage. Its local session file can disappear on restart or sleep. FIELDWORK detects that loss and offers a fresh scout; it does not claim durable cloud storage. The first visit after sleep can also take longer to load.

The [request guard](../docs/REQUEST_BUDGET.md) limits one process to two expensive operations at a time and conservative Qloo/Groq request counts. Counters reset when the process restarts. They are backpressure, not a billing cap; provider Free plans and the account's billing settings remain authoritative.

Run IDs permit access to a brief without an account. Use demonstration briefs without private client data and avoid displaying active run IDs in public recordings. Production use would require authentication, durable storage and a distributed quota system.

Official references: [Render web services and public repositories](https://render.com/docs/web-services), [Render default environment variables](https://render.com/docs/environment-variables), [Render Free](https://render.com/docs/free), [Groq model permissions](https://console.groq.com/docs/model-permissions), [Groq rate limits](https://console.groq.com/docs/rate-limits).
