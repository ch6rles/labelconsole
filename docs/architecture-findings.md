# Architecture findings

Step 0 of the build asked for an inspection of the existing project before anything was written. This records what was found, the architecture that followed from it, and every place where the build interprets or departs from [the spec](label-console-plan.md).

## What existed

The repository was empty apart from the design export (`Label Console.dc.html` and `support.js`), so the build uses the default stack from the spec's Architecture section. There was no existing auth, database, API style, UI library or deployment target to reuse.

## Resulting architecture

```
apps/web        Next.js App Router: console pages, /api/v1 router, auth, SSE, webhooks
apps/worker     Persistent worker: BullMQ queues, outbox dispatcher, schedules, health
packages/core   Tenancy + RLS, auth, permissions, vault, audit, events, queue, tools, LLM, storage, metrics, plans
packages/ui     Design tokens, console shell, primitives (tables, charts, kanban, forms, drawers)
modules/*       Ten modules: manifest, schema, service, api, jobs, listeners, agent-tools, ui
```

| Concern | Choice | Where |
|---|---|---|
| Language and runtime | TypeScript end to end on Node 22; Zod schemas shared by API routes and UI forms | everywhere |
| Web | Next.js 16 App Router, React 19. A catch-all page route resolves module pages from each module's `web.ts`; a catch-all API route dispatches to module routes | `apps/web/src/app/(console)/[...slug]`, `apps/web/src/app/api/v1/[...path]` |
| Auth | Own org-aware sessions: scrypt password hashes, opaque session tokens (hashed in the DB) in an HttpOnly cookie, a label switcher, invitations. Chosen over Auth.js or Clerk because sessions carry the active label and its permission set, and nothing paid is involved | `packages/core/src/auth.ts` |
| Database | Postgres 16 with Drizzle. Two roles: the restricted app role runs every tenant query under row-level security (`withOrg` sets `app.org_id`); the owner role is only for cross-tenant work (sign-up, session lookup, scheduler fan-out, webhook routing, operator metrics) | `packages/core/src/context.ts`, `db/rls.ts`, `db/client.ts` |
| Events | Transactional outbox (`domain_events`, written in the same transaction as the change), dispatched by the worker to listeners through the `events` queue, and pushed to browsers over Redis pub/sub and SSE | `packages/core/src/events.ts`, `worker.ts`, `realtime.ts` |
| Jobs | BullMQ on Redis: `jobs`, `agents` and `events` queues, repeatable schedules, retries with backoff, rate-limited reschedules that don't burn attempts | `packages/core/src/queue.ts`, `worker.ts` |
| Files | S3-compatible storage (S3 or R2) with signed URLs, or a local driver for development; type sniffing, size limits and ClamAV scanning on upload | `packages/core/src/storage.ts`, `scan.ts` |
| Secrets | Envelope encryption: the master key (env, or a KMS provider) wraps per-label data keys, which encrypt credentials with AES-256-GCM. Decryption only in the worker; tools get credential handles | `packages/core/src/vault.ts` |
| LLM | Provider interface with the Anthropic SDK as the implementation; per-agent model choice, adaptive thinking, prompt caching, server-side web search, pricing table for cost | `packages/core/src/llm.ts`, `llm-models.ts` |
| Design | Tokens extracted from the design file into CSS variables; the shell (sidebar, top bar, label switcher, command palette, notifications, agent indicator) and primitives in `packages/ui`; `support.js` behaviour ported into typed hooks | `packages/ui/src` |
| Tests | Vitest: unit, integration (real Postgres and Redis, a fresh database per run), an opt-in agent load test, and a restore drill script | `vitest.config.ts`, `test/`, `scripts/restore-drill.ts` |
| Operations | Docker images (web standalone; worker bundle plus only its runtime packages), docker compose, Prometheus metrics with a Grafana dashboard and alerts, backups | `Dockerfile`, `docker-compose.yml`, `infra/`, `docs/operations.md` |

### How modules plug in

Each module exports a server definition (`server.ts`) and a web definition (`web.ts`). Both apps register the same list. The core never imports a module; modules import each other only through `service/` functions and typed events.

| Hook | Used for |
|---|---|
| `routes` | API endpoints, each with a permission and Zod body/query schemas |
| `jobs`, `schedules`, `listeners` | Background work, repeatable schedules, event handlers (run in the worker) |
| `tools` | Agent tools with JSON schema, permission, risk level, timeout, rate limit, idempotency |
| `attention`, `stats`, `widgets`, `search`, `shell` | Dashboard, sidebar widgets, command palette, top-bar counts |
| `enrich` | Columns one module adds to another's lists (for example streams per artist) |
| `onboarding` | Steps in the getting-started checklist |
| `planUsage` | How much of each plan limit the label uses |
| `metrics` | Aggregate operational metrics for `/api/metrics` |
| `pages`, `panels` (web) | Console pages and panels on other modules' detail pages |

Turning a module off for a label (or a plan that lacks it) removes its nav, its pages (the router matches only enabled modules), its API routes, its listeners and its agent tools.

## Interpretations and departures from the spec

| Spec | What was built | Why |
|---|---|---|
| Auth.js or Clerk if starting fresh | Own session auth | Org-aware sessions and permission sets are central; avoids a paid dependency |
| Stream snapshots "partitioned by month or stored in TimescaleDB" | Native Postgres monthly partitions, maintained by a daily job | No extra extension to operate |
| Long-term memories "stored with embeddings (pgvector), retrieved by relevance" | Memories are embedded in the background with Voyage AI. Recall ranks by cosine similarity plus full-text rank, then importance and recency | Embedding outside the write transaction keeps writes fast and never blocks on the provider. Without a key, or when Voyage fails, recall falls back to full-text search, so memory always works |
| "Do NOT scrape Spotify"; Spotify counts from a licensed vendor | Spotify play counts, credits, ISRC search, artist audiences and playlist followers come from SpotScraper, a third-party API | The owner's decision. SpotScraper most likely scrapes Spotify. It is isolated behind one client (`packages/core/src/spotscraper.ts`) and its own stream source, so it can be swapped for a licensed vendor without touching the rest |
| Licensed stream-data provider adapter | Interface and registry only | Kept for a licensed vendor alongside SpotScraper |
| Spotify Web API in metadata lookup | Adapter present, used only with the label's own credentials | Commercial use needs extended access; Deezer, MusicBrainz and Apple cover ISRC/UPC |
| Observability: OpenTelemetry traces, Sentry | Structured logs (pino), Prometheus metrics, Grafana dashboard, alert rules, deep health check | Sentry is a paid service and a tracing backend is a choice to make; metrics cover dashboards and alerting now |
| Billing | Plan tiers gate modules; per-plan limits on seats, tracked tracks and storage, enforced when something is added; usage on Settings → Plan & usage | Taking payments needs a payment provider (paid); limits are placeholders until pricing is set |
| Agent types: "first three" in Phase 6 | All eight types from the spec, plus Social Scout and a Custom agent | The registry made them cheap to add as files |
| Social signals from official platform APIs | TikTok, Instagram and YouTube profiles, posts and searches come from Apify scrapers (`packages/core/src/apify.ts`), read-only, through agent tools | The owner's decision. The platforms' own APIs don't offer search or other people's stats. Results are normalised in `modules/network/social/` before an agent sees them, and nothing is posted or sent through them |
| Agents act as a service principal "capped at the permissions of the user who created it" | Role ∩ owner's permissions, ∩ the parent run's for delegated runs; frozen when a run starts | Stricter-of-both rule from the delegation section applied consistently |
| Artist portal | Not built; artist-scoped access exists for staff (`artistScope` on the service context) | The spec marks the portal as a later phase |

## Things to know when changing the code

- **PATCH schemas must use `patchOf()`** from `@labelconsole/core/zod`. Zod 4's `.partial()` keeps defaults, so a partial update would silently reset fields.
- **Tenant data goes through `withOrg`.** The system connection bypasses RLS; it's only for the cross-tenant cases listed above. Module metrics hooks receive it as an argument and must return aggregates only.
- **Long work goes in jobs.** Route handlers write, enqueue (after commit) and return.
- **Audit entries for sensitive records set `readPermission`** (for example `documents:read_confidential`), so the activity feed only shows them to people who could open the record. Settings entries need `settings:audit`.
- **Role changes stay within the actor's own access.** Nobody can assign, change or remove a role that holds permissions they don't have.
- **Every permission key must be declared by a module.** A unit test fails on undeclared keys, because a typo silently hides a feature.
- **Agent tools never see secrets or raw Spotify responses.** They receive credential handles and derived numbers. SpotScraper responses are normalised inside its client and stored as numbers; tools read those.
- **Outbound fetches of links someone else chose use `fetchPublicFile` (`packages/core/src/net.ts`).** It allows only public https addresses, checks every resolved address at connect time and every redirect, and caps size and time. Use it for anything an agent or a label supplies.
- **Cut text with `clip()` from `@labelconsole/core/tools`, not `slice()`, before it goes into a json column.** Half of an emoji is invalid Unicode, and Postgres refuses the whole row.
- **One Spotify ID per tracked track.** Streams polls the identity with variant `primary`. Adding another Spotify identity never changes the polled one unless staff choose it, and `upsertIdentity` keeps an existing variant unless a new one is given.
