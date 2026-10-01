# Operations

How to deploy, configure, scale, back up and watch Label Console. Architecture background is in [architecture-findings.md](architecture-findings.md).

## What runs

| Process | What it does | Scale |
|---|---|---|
| **web** (`apps/web`) | Console pages, `/api/v1`, auth, SSE, inbound webhooks, `/api/health`, `/api/metrics` | Stateless; run as many as you like behind a load balancer. Serverless hosts work too |
| **worker** (`apps/worker`) | Every job, schedule, event listener and agent run | Long-lived; one or more processes on a host that keeps them alive. BullMQ gives each job to exactly one worker |
| **migrate** (release step) | `node dist/migrate.js` in the worker image: migrations, custom SQL, RLS policies, grants | Once per deploy, before new code starts |
| Postgres 16 + pgvector + pg_trgm | All data | Managed Postgres is fine; the app needs two roles (below) |
| Redis 7 | Queues, pub/sub, rate limits, metrics counters | Persistence (AOF) on |
| S3 or R2 | Uploaded files | Turn on versioning |

## Deploying with Docker

```sh
docker build --target web    -t labelconsole-web .
docker build --target worker -t labelconsole-worker .

# Fresh Postgres only (creates roles, database and extensions; needs DATABASE_SUPERUSER_URL):
docker run --rm --env-file prod.env labelconsole-worker node dist/setup.js
# Every deploy, before starting new code:
docker run --rm --env-file prod.env labelconsole-worker node dist/migrate.js

docker run -d --env-file prod.env -p 3000:3000 labelconsole-web
docker run -d --env-file prod.env --stop-timeout 70 labelconsole-worker
```

On SIGTERM the worker stops taking jobs, lets active ones finish (up to 60 seconds) and exits; give it at least 70 seconds to stop. Agent runs interrupted by a hard kill resume from their last checkpoint on another worker.

To try the whole stack on one machine: `docker compose up --build` (see `docker-compose.yml`).

Behind a TLS-inspecting proxy, pass its CA to the dependency download: `docker build --secret id=npm_ca,src=ca.pem ...`.

### Managed Postgres

Create two roles and give the database to the owner:

- **owner** (`DATABASE_SYSTEM_URL`): owns the schema, runs migrations, does cross-label system work. Not a superuser.
- **app** (`DATABASE_URL`): `NOBYPASSRLS`, `LOGIN`; every tenant query runs as this role under row-level security.

Create the `vector` and `pg_trgm` extensions as an admin, or run `dist/setup.js` once with an admin URL in `DATABASE_SUPERUSER_URL`.

## Configuration

Set in the environment (see `.env.example`). The app refuses to start if a required value is missing or malformed.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | App role (RLS applies) |
| `DATABASE_SYSTEM_URL` | yes | Owner role |
| `REDIS_URL` | yes | |
| `APP_URL` | yes | Public origin; used for links, cookies and CSRF origin checks |
| `VAULT_MASTER_KEY` | yes | 32 bytes, base64. Wraps each label's data key. **Back it up separately from the database**: without it, stored credentials can't be decrypted |
| `VAULT_MASTER_KEY_ID` | | Recorded with each wrapped key and in backup manifests |
| `SIGNING_SECRET` | yes | 32+ bytes; signed storage URLs and webhook tokens |
| `STORAGE_DRIVER` | | `s3` in production (`local` for development and single-box installs) |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | with `s3` | R2 works through `S3_ENDPOINT` |
| `ANTHROPIC_API_KEY` | for agents | Platform default; a label's own key (Settings → Integrations) takes precedence. Without either, agents don't start runs and contract extraction is skipped |
| `ANTHROPIC_WORKSPACE_ID` | | Only for a personal key that isn't scoped to one workspace: the workspace to bill (`wrkspc_…`), sent as `anthropic-workspace-id` |
| `VOYAGE_API_KEY` | for semantic memory | Voyage AI embeddings for agent memory; labels can add their own. Without it, recall uses full-text search only |
| `VOYAGE_MODEL` | | Embedding model (default `voyage-4`; must produce 1024 dimensions). Changing it re-embeds every memory in the background |
| `YOUTUBE_API_KEY` | for stream tracking | Platform default; labels can add their own. 10,000 units/day per Google project by default; request more before many labels onboard |
| `METRICS_TOKEN` | | Enables `/api/metrics` with this bearer token |
| `CLAMAV_HOST`, `CLAMAV_PORT` | | Upload virus scanning via clamd; without it files are marked "not scanned" |
| `WORKER_CONCURRENCY` | | Concurrent general jobs per worker process (default 8) |
| `WORKER_AGENT_CONCURRENCY` | | Concurrent agent runs per worker process (default 8) |
| `AGENT_CONCURRENCY_PER_ORG` | | Agent runs one label may have going at once (default 4) |
| `WORKER_HEALTH_PORT` | | Worker's `/healthz` port (default 9091) |
| `HTTP_USER_AGENT` | | Sent to public APIs (MusicBrainz requires a descriptive one) |
| `LOG_LEVEL` | | pino level |

Also read directly: `DB_POOL_MAX` / `DB_SYSTEM_POOL_MAX` (connection pools), `DB_APP_ROLE` (if the app role name differs from `DATABASE_URL`'s user), `LC_QUEUE_PREFIX` (Redis key prefix), `LC_MIGRATIONS_DIR` (set in the worker image), `DATABASE_SUPERUSER_URL` (setup and the restore drill only), `LC_DEV_SEED` (development seed only).

## Scaling

- **Web** is stateless. SSE connections are held by whichever instance a browser reaches; events fan out through Redis.
- **Workers** scale horizontally. Each process runs `WORKER_AGENT_CONCURRENCY` agent runs (default 8; they mostly wait on the model, so 32 or more is reasonable), `WORKER_CONCURRENCY` general jobs and 16 event deliveries at once. Per-label limits (`AGENT_CONCURRENCY_PER_ORG`) are enforced in the database across all processes.
- **Measured** (`pnpm test:load`, one worker process with 32 agent slots, stub model at 60–180 ms per call, local Postgres and Redis):

  | Load | Wall time | Throughput | Per-label max running | Reads during load (p95) |
  |---|---|---|---|---|
  | 12 labels × 4 agents × 2 runs = 96 runs | 4.5 s | ~1,300 runs/min | 4 (limit 4) | 42 ms |
  | 40 labels × 5 agents × 2 runs = 400 runs | 15.7 s | ~1,500 runs/min | 2 | 36 ms |

  Every run completed with exactly three model calls and no repeated tool side effects. Real runs are bound by model latency and budgets, not the platform; add worker processes when `lc_queue_jobs{queue="agents",state="waiting"}` stays high.

## Backups and restore

```sh
pnpm db:backup                       # ./backups (or BACKUP_DIR / --out)
pnpm db:restore-drill                # back up now, restore into a scratch DB, verify, drop it
pnpm db:restore-drill -- --from backups/labelconsole-….manifest.json
```

A backup is a `pg_dump` (custom format) taken from an exported snapshot, plus a manifest with the row count of every table **from the same snapshot**, a checksum, and (for local storage) a tarball of uploaded files. With S3/R2, rely on bucket versioning and replication for files.

The restore drill restores into a fresh database on the same server and fails unless:

1. the dump checksum matches,
2. every table has exactly the row count in the manifest,
3. the migration history matches,
4. the app role still sees nothing without a label and only that label's rows with one (RLS survived),
5. every label key unwraps and every credential decrypts with the current `VAULT_MASTER_KEY`.

Run backups on a schedule (cron, a Kubernetes CronJob) with a `pg_dump` that matches the server version (16), ship them off-site, and run the drill regularly; it writes `test-results/restore-drill.json`. Managed Postgres point-in-time recovery is a good complement, not a replacement: the drill also proves the vault key and RLS.

**Restoring for real:** create the roles (or run `dist/setup.js`), `pg_restore --no-owner --dbname=$DATABASE_SYSTEM_URL <file>.dump` as the owner role, run `dist/migrate.js`, and start the apps with the **same `VAULT_MASTER_KEY`**.

## Monitoring

- **Health:** `GET /api/health` (Postgres and Redis; use for load-balancer probes) and `GET /api/health?deep=1` (also a live worker heartbeat and outbox lag under 5 minutes; use for uptime monitors). The worker serves `GET /healthz` on `WORKER_HEALTH_PORT`.
- **Metrics:** `GET /api/metrics` with `Authorization: Bearer $METRICS_TOKEN`. One scrape covers every process: queue depths, workers alive, outbox lag, job throughput, failures and durations, agent runs by status, tokens, spend, pending approvals, stalled runs, stream registry and overdue polls, document extraction. Aggregates only, no label data.
- **Dashboard and alerts:** `infra/grafana/label-console.json` (import, pick the Prometheus data source), `infra/prometheus/prometheus.yml` and `alerts.yml` (no worker, outbox backlog, job failure rate, queue backlog, stalled agent runs, overdue stream polls, high agent spend).
- **Logs:** JSON (pino) on stdout from both processes; job failures log the job name, id, attempt and error.

## Runbook

| Symptom | Check | Fix |
|---|---|---|
| `NoWorkerRunning` / deep health says no heartbeat | Worker container logs | Restart the worker. Agent runs resume from checkpoints; schedules re-register on start |
| `OutboxBacklog` | `lc_outbox_pending`, worker logs for listener errors | Usually a failing listener; fix and restart. Events are dispatched in order and never lost |
| Agents doing something unwanted | Agents page | **Stop all agents** (kill switch, per label) stops running agents at their next step and blocks new runs. Per run: Stop on the run page aborts in-flight calls |
| `AgentRunsStalled` | `lc_agent_runs_stalled` | The minute tick re-queues runs whose lease expired; if it persists, the `agents.tick` schedule isn't running (restart the worker) |
| `StreamPollsOverdue` | `streams.poll-org` job logs | YouTube quota exhausted (resets at midnight Pacific; request more quota) or the key is missing or revoked |
| Agent runs refused with "No Anthropic API key" | Settings → Integrations | Add the label's key, or set `ANTHROPIC_API_KEY` for the platform |
| Agent runs fail with "API key is not scoped to a workspace" | Settings → Integrations → Anthropic | Fill in Workspace ID (`wrkspc_…`), or set `ANTHROPIC_WORKSPACE_ID`, or use a workspace-scoped key |
| Memory page says "semantic recall off", or `lc_agent_memories_unembedded` keeps growing | Settings → Integrations → Voyage AI | Add a key or set `VOYAGE_API_KEY`; check the worker can reach `api.voyageai.com` |
| A label hits a plan limit (402 `plan_limit`) | Settings → Plan & usage | Change the label's plan (`organizations.plan`) or free up seats, tracks or storage. Limits live in `packages/core/src/plans.ts` |
| Changing the vault master key | `verifyVault()` | Not automated yet: unwrap each label key with the old key and re-wrap it with the new one, then run the restore drill with the new key |
