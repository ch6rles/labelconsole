# Label Console: project overview and working notes

A condensed reference covering what Label Console is, how it works, how to run it, and what came up while running and deploying it.

## Purpose

Label Console is a multi-tenant web workspace for record labels. One place to manage the catalogue, roster, contracts, royalties, files, stream numbers, marketing and outreach, with AI agents that do background work through the same services and permissions as human staff.

Each label is a separate tenant. Every table belongs to a label and is isolated with Postgres row-level security. Credentials (API keys, mailbox logins) are envelope-encrypted and only decrypted in the background worker.

## Features by section

| Section | What it does |
|---|---|
| **Dashboard** | Getting-started checklist, items needing attention, recent activity, stats |
| **Catalog** | Releases, tracks, demos, credits and splits. Paste a Spotify, Apple, Deezer or YouTube link, an ISRC or a UPC and the details are looked up (`POST /v1/metadata/resolve`), including a distributor guess with evidence. Bulk import and a public demo submission form |
| **People** | Artist roster with onboarding progress and payout details; staff directory |
| **Documents** | Contracts with AI term extraction that a person confirms before anything is applied; key dates and reminders |
| **Finance** | Distributor statements parsed and matched to tracks; royalties by month, source and release |
| **Drive** | Label file storage with folders, per-folder permissions, links to any record, optional Google Drive connection |
| **Streams** | YouTube view tracking (official API, quota-aware), exact counts from distributor statements, Spotify plays via SpotScraper or a licensed vendor, alerts on spikes, drops and milestones |
| **Network and Marketing** | CRM for creators, editors and press; campaigns with KPIs and stream changes; pipeline boards that double as the booking ledger; pitch tracker that sends through the label's mailbox; sketchboards |
| **Agents** | Eight agent types (below) running in the background |
| **Inbox** | Notifications, approvals queue, activity feed |
| **Admin and Settings** | Roles and custom roles, audit log, integrations vault, plan and usage, full data export, turning modules on or off per label |

### AI agents

Label Manager, Playlist & Editor Outreach, Creator Outreach, Trend & Social Monitor, A&R Scout, Stream Watch, Release Ops, Contract & Statement Watch.

- Run on schedules, events or webhooks, can delegate to each other, and keep memory (semantic memory with a Voyage AI key).
- Have budgets; anything risky (sending email, changing records) goes to the approvals queue for a person to approve.
- Each run is checkpointed after every step and resumes after a crash.
- Need an `ANTHROPIC_API_KEY` (platform-wide in env, or per label under Settings → Integrations).

## How it works

### Processes

| Process | Role |
|---|---|
| **web** (`apps/web`) | Next.js 16 / React 19 app: console pages, `/api/v1` API, sign-in, live updates (SSE), inbound webhooks, `/api/health`, `/api/metrics`. Stateless, scales out freely |
| **worker** (`apps/worker`) | Runs every background job, schedule, event listener and agent run (BullMQ). Long-lived; scale by adding processes |
| **migrate** | Release step (`node dist/migrate.js`): migrations, row-level security policies, grants. Runs once per deploy before new code |
| **Postgres 16** + pgvector + pg_trgm | All data. Two roles: restricted app role (RLS applies) and owner role (migrations, cross-tenant system work) |
| **Redis 7** | Job queues, pub/sub for live updates, rate limits, metrics counters |
| **S3 / R2 bucket** | Uploaded files (local folder in development) |

### Typical workflow

1. A user does something in the web app, such as uploading a distributor statement.
2. Web saves the change and writes an event to an outbox table in the same database transaction, then queues a job in Redis.
3. The worker picks up the job (for example, parse the statement), reads the file from storage, and writes results such as royalty lines matched to tracks.
4. Events are delivered to listeners in other modules (for example, register new tracks for stream tracking) and pushed to open browsers over Redis pub/sub and SSE.
5. Agents run on their schedules or triggers through the same services; risky actions wait in the approvals queue.

Because of this, **web and worker must share the same Postgres, Redis, file storage, `VAULT_MASTER_KEY` and `SIGNING_SECRET`.**

### Code layout

```
apps/web        Next.js app: pages, API router, auth, realtime, webhooks
apps/worker     Background worker: jobs, schedules, event listeners, agent runs
packages/core   Tenancy and RLS, auth, permissions, vault, events, queues, tools, LLM, storage, metrics
packages/ui     Design tokens, console shell and components
modules/*       agents, catalogue, documents, drive, inbox, marketing, network, people, settings, streams
infra/          Prometheus and Grafana config
docs/           Spec, architecture, operations, progress
```

Each module owns its schema, services, API routes, jobs, listeners, agent tools and pages, and talks to other modules only through their services and typed events. Turning a module off for a label removes all of it.

## Running locally

Needs Node 22, pnpm 10, Postgres 16 with pgvector, and Redis.

```sh
pnpm install
cp .env.example .env            # set VAULT_MASTER_KEY (openssl rand -base64 32) and SIGNING_SECRET (openssl rand -hex 32)
pnpm db:setup && pnpm db:migrate
LC_DEV_SEED=1 pnpm db:seed      # sample label: demo@northline.test / correct horse battery
pnpm dev                        # web on http://localhost:3000 plus the worker
```

Or everything in containers: `docker compose up --build`.

Optional keys: `ANTHROPIC_API_KEY` (agents, contract reading), `YOUTUBE_API_KEY` (stream tracking), `VOYAGE_API_KEY` (agent memory), `SPOTSCRAPER_API_KEY` (Spotify plays).

### Notes from running it

- **pgvector must be installed** in Postgres (`postgresql-16-pgvector` on Debian/Ubuntu), or `db:setup` can't create the extension.
- **Use an absolute `STORAGE_LOCAL_DIR`.** The default `.storage` is relative, so the seed script writes files under the repo root while the worker looks in `apps/worker/.storage`. The worker then crashes with `ENOENT` on its first statement job. Setting `STORAGE_LOCAL_DIR=/full/path/to/labelconsole/.storage` fixes it. Worth fixing in `.env.example` or in how the path is resolved.
- **Redis started from the repo folder writes `dump.rdb` there.** Start Redis from elsewhere, or turn snapshots off for development (`redis-cli config set save ""`). It's not in `.gitignore`.
- Once running, signing in as the demo user opens the Northline Records dashboard with the setup checklist 7 of 9 done (YouTube and an Anthropic key left).

## Deploying on Railway

Current setup: services **web**, **worker**, **postgres** (pgvector volume), **redis** (volume) and a **bucket**.

Lines on the Railway canvas only show that a service's variables reference another service (for example `${{Postgres.DATABASE_URL}}`). A worker with no lines isn't broken by itself, but it must have the same connections as web:

| Variable | Worker needs |
|---|---|
| `DATABASE_URL`, `DATABASE_SYSTEM_URL` | Same Postgres as web (app role and owner role) |
| `REDIS_URL` | Same Redis as web, or queued jobs are never picked up |
| `STORAGE_DRIVER=s3` + `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The bucket; local storage doesn't work across separate services |
| `VAULT_MASTER_KEY`, `VAULT_MASTER_KEY_ID`, `SIGNING_SECRET` | Exactly the same values as web, or saved credentials can't be decrypted |
| `ANTHROPIC_API_KEY`, `YOUTUBE_API_KEY`, etc. | Any platform keys you use |

Using reference variables for the database, Redis and bucket makes the lines appear and keeps values correct if those services change.

**Check the worker is really connected:** upload a distributor statement in the app and watch the worker logs. It should log the job and the statement should get parsed. "Online" only means the process started.

## Useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Web and worker with reload |
| `pnpm typecheck` | TypeScript across the repo |
| `pnpm test` | Unit and integration tests |
| `pnpm build` | Production build |
| `pnpm db:setup` / `db:migrate` / `db:reset` | Create roles and database / apply migrations and RLS / start over |
| `pnpm db:seed` | Sample data (only with `LC_DEV_SEED=1`, never in production) |
| `pnpm db:backup` / `db:restore-drill` | Back up / prove a backup restores |

## Further reading

- [label-console-plan.md](label-console-plan.md): the full spec
- [architecture-findings.md](architecture-findings.md): architecture and how modules plug in
- [operations.md](operations.md): deploying, configuration, scaling, backups, monitoring, runbook
- [progress.md](progress.md): what each phase delivered and open decisions
