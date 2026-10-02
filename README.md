# Label Console

A multi-tenant workspace for record labels: catalogue, roster, marketing, contracts and statements, files, live stream data, and autonomous AI agents that work through the same services and permissions as staff.

- **Catalogue:** releases, tracks, demos, credits and splits. Paste a Spotify, Apple, Deezer or YouTube link, an ISRC or a UPC and the details are resolved (`POST /v1/metadata/resolve`), including a distributor guess with its evidence. Bulk import and a public demo intake form.
- **People:** artist roster with onboarding progress and payout details, staff directory.
- **Documents and Finance:** contracts with AI term extraction that a person confirms before anything applies, key dates and reminders, distributor statements parsed and matched to tracks, royalties by month, source and release.
- **Drive:** label file storage with folders and per-folder permissions, links to any record, an optional Google Drive connection.
- **Streams:** YouTube view tracking (official API, quota-aware), exact counts from distributor statements, an interface for a licensed Spotify data vendor, alerts on spikes, drops and milestones (`/v1/streams/...`).
- **Network and Marketing:** a creator, editor and press CRM; campaigns with KPIs and stream deltas; pipeline boards that double as the booking ledger; a pitch tracker that sends through the label's mailbox; sketchboards.
- **Agents:** ten agent types (Label Manager, Playlist & Editor Outreach, Creator Outreach, Trend & Social Monitor, A&R Scout, Social Scout, Stream Watch, Release Ops, Contract & Statement Watch, and a Custom agent you configure yourself). Social research on TikTok, Instagram and YouTube runs through Apify.
  - Agents run in the background with schedules, event and webhook triggers, delegation, memory, budgets and approvals for anything risky.
  - Each run is checkpointed after every step and resumes after a crash.
- **Inbox, Admin and Settings:** notifications, the approvals queue, an activity feed, roles and custom roles, an audit log, an integrations vault, plan and usage, and full data export.

Every table belongs to a label and is isolated by Postgres row-level security; credentials are envelope-encrypted and only decrypted in the worker.

## Quick start (local development)

Needs Node 22, pnpm 10, Postgres 16 with pgvector, and Redis.

```sh
pnpm install
cp .env.example .env            # fill VAULT_MASTER_KEY (openssl rand -base64 32) and SIGNING_SECRET (openssl rand -hex 32)
pnpm db:setup && pnpm db:migrate
pnpm dev                        # web on http://localhost:3000 and the worker
```

Then open http://localhost:3000. The first visit sets up the label (`LABEL_NAME`, "River Of Styxx" by default) and its owner account. There is no public sign-up: once the label exists, setup closes, and your team joins by invitation (Admin → Users).

- Forgot the password, or need a second owner: `pnpm owner --email you@example.com` (with Docker: `docker compose run --rm worker node dist/owner.js --email you@example.com`). It asks for the password without showing it, and creates the label and account if they don't exist yet.
- Add `ANTHROPIC_API_KEY` (agents, contract reading), `VOYAGE_API_KEY` (agent memory), `SPOTSCRAPER_API_KEY` (Spotify plays, credits, audiences), `APIFY_API_TOKEN` (TikTok, Instagram and YouTube research) and `YOUTUBE_API_KEY` (YouTube views) to `.env`, or add them under Settings → Integrations.
- `LC_DEV_SEED=1 pnpm db:seed` creates a sample label (demo@northline.test / correct horse battery) for development. Seeding first closes setup, so use `pnpm owner` afterwards for your own label.

Or run everything in containers: `docker compose up --build`.

## Deploying

To put it online, follow [docs/deploy-railway.md](docs/deploy-railway.md). It sets up the website, worker, Postgres with pgvector, Redis and a storage bucket on Railway. Serverless hosts such as Netlify or Vercel can't run it: the app needs an always-on worker, a database and Redis alongside the website.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Web app and worker with reload |
| `pnpm typecheck` | TypeScript across packages, modules, worker, tests and scripts (`cd apps/web && npx tsc --noEmit` for the web app) |
| `pnpm test` | Unit and integration tests (integration uses a throwaway database and Redis prefix) |
| `pnpm test:load` | Agent load test through the real worker (stub model); opt-in |
| `pnpm build` | Production build: Next standalone output and the bundled worker |
| `pnpm db:setup` / `db:migrate` / `db:reset` | Create roles and database / apply migrations and RLS / start over |
| `pnpm db:generate` | Generate a migration from schema changes (drizzle-kit) |
| `pnpm db:seed` | Sample data, only with `LC_DEV_SEED=1` and never in production |
| `pnpm owner --email …` | Make sure the label exists and you own it with a new password (account recovery) |
| `pnpm db:backup` / `db:restore-drill` | Back up the database and files / prove a backup restores and works |

## Layout

```
apps/web        Next.js app: console pages, API router, auth, realtime, webhooks
apps/worker     Background worker: jobs, schedules, event listeners, agent runs
packages/core   Tenancy and RLS, auth, permissions, vault, events, queues, tools, LLM, storage, metrics
packages/ui     Design tokens, console shell and components
modules/*       catalogue, people, documents, drive, streams, network, marketing, agents, inbox, settings
infra/          Prometheus and Grafana config
docs/           Spec, architecture, operations, progress
```

Each module owns its schema, services, API routes, jobs, listeners, agent tools and pages, and talks to other modules only through their services and typed events. Switching a module off for a label removes all of it.

## Docs

- [docs/label-console-plan.md](docs/label-console-plan.md): the spec this was built from
- [docs/architecture-findings.md](docs/architecture-findings.md): architecture, how modules plug in, where the build departs from the spec
- [docs/operations.md](docs/operations.md): deploying, configuration, scaling, backups, monitoring, runbook
- [docs/progress.md](docs/progress.md): what each phase delivered and how to verify it, plus open decisions
