# Label Console — build progress

> **Current position:** All seven phases are done. What's left are decisions only the owner can make (see **Open decisions**), plus the follow-ups listed under **Next steps**.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: pnpm monorepo, core platform (tenancy + RLS, auth/sessions, permissions, vault, audit, outbox events, BullMQ queues, worker service, SSE realtime, storage), design system, console shell | Done |
| 2 | Catalogue + in-house metadata lookup (`POST /v1/metadata/resolve`, distributor inference, bulk import, demos + public intake) | Done |
| 3 | People, Drive, Documents (contracts with AI term review, statements, royalties, key dates) | Done |
| 4 | Streams (YouTube Data API adapter, statement-import adapter, licensed-provider interface, snapshots, rollups, alerts) | Done |
| 5 | Network (contacts, interactions, playlists) + Marketing (campaigns, pipeline boards, outreach, sketchboards) | Done |
| 6 | Agent system (orchestrator, checkpointed runtime, tools, memory, triggers, approvals, budgets, delegation, kill switch, 8 agent types) + Inbox approvals page | Done |
| 7 | Hardening: load tests, backups and restore drill, observability, billing (plan limits), onboarding, dev seed, Docker, docs | Done |

## Phase 1 acceptance

- **Two test labels cannot see each other's data:** `packages/core/src/rls.int.test.ts` runs as the restricted app role and checks that rows of one label are invisible to the other, and that writes into another label are rejected by RLS.
- **A background job runs on the worker with the browser closed:** `packages/core/src/worker.int.test.ts` runs a queued job on a real worker scoped to its label, delivers committed outbox events to listeners, and never delivers events from a rolled-back transaction.
- **The shell matches the design file:** tokens, sidebar, top bar, label switcher, command palette, notifications and agent indicator were built from `Label Console.dc.html` and compared at desktop and mobile widths.
- Also covered: sessions and invitations (`auth.int.test.ts`), the vault (`vault.int.test.ts`), permissions (`permissions.test.ts`).

## Phase 2 acceptance

- **Pasting a DSP link or ISRC creates a release and track with ISRC, UPC and a distributor guess with evidence:**
  - `modules/catalogue/metadata/metadata.test.ts` covers link, ISRC, UPC and "Artist - Title" parsing, embedded ID3 tags, merging by source priority with conflicts, distributor inference (label text, learned UPC prefixes, a licensed field), and resolving an ISRC through Deezer, MusicBrainz and iTunes.
  - `modules/catalogue/catalogue.int.test.ts` covers confirming a resolved lookup into releases, tracks, artists and platform identities; release readiness; and the bulk-import CSV parser.

## Phase 3 acceptance

- Upload a contract and Claude reads its terms in the worker (`documents.extract`). Nothing is applied until a person reviews and confirms the terms on the document page; confirming creates the key dates (options, notices, expiry) and links the artists named as parties.
- Statements (distributor CSV, or PDF read by Claude) are parsed into `statement_lines`, matched to tracks by ISRC and UPC, and summarised with anomaly checks against the previous statement.
- Finance → Royalties shows 12 months of booked revenue, the split by source, and top releases for the latest booked period, with artist and label shares taken from confirmed contract terms. Revenue without confirmed terms is shown as "not yet split", never guessed. CSV export is included.
- Confidential documents and statements are hidden from roles without `documents:read_confidential` / `documents:read_financial`, and every view of a confidential document is logged. Covered by `modules/documents/documents.int.test.ts`.
- Tests: 50 passing (unit and integration).

## Phase 4 acceptance

- **Track registry:** every catalogue track is registered via listeners on `catalogue.track.created` and `catalogue.track.imported`; the scheduler also backfills tracks created before Streams was switched on.
- **YouTube resolver:** one `search.list` (100 units) per track. The Topic art track is preferred, then the official video; matches are scored on channel, title, length and version. Confidence of 0.85 or more is confirmed automatically, 0.5–0.85 goes to the Matching review queue, and staff can paste a link.
- **Polling:** `streams.schedule` runs every 15 minutes with nobody signed in and fans out `streams.poll-org`. Polling uses `videos.list` only, batched 50 IDs per call (1 unit), with a per-API-key quota token bucket in Redis. Active tracks (recent releases, live campaigns via the `stream-tier` enrich hook) poll every 6 hours; back catalogue polls daily.
- **Snapshot store:** append-only `stream_snapshots`, partitioned by month and maintained daily. `stream_daily` rollups record the source of every row; a video's growth counts only from its second reading, so a newly added video never shows as a spike.
- **Statement-import adapter:** listens for `documents.statement.parsed` and recomputes exact period counts from current statements, so a re-import replaces rather than adds.
- **Licensed-provider adapter:** interface and registry only, and skipped until a vendor is chosen.
- **API:** `/v1/streams/tracks/:id`, `/v1/streams/artists/:id` and `/v1/streams/movers`, plus the registry, matching, alerts and rules endpoints. The `streams.snapshot.recorded` domain event is emitted, and a signed batch webhook (public https only) is sent if the label configures one.
- **Alerts:** spike and drop rules check the last complete day against the trailing average; milestone rules fire once. Alerts emit `streams.alert`, which Inbox notifies on.
- **UI:** overview, tracks, track detail, matching and alerts pages, plus track and artist panels, the dashboard "STREAMS · 28D" stat and People's Streams 28d column.
- **Agent tools:** `streams_get_history` and `streams_top_movers` return derived numbers only.
- **Tests:** 66 passing. They cover polling, rollups, alerts, the resolver, statement import, the missing-key path, the scheduler fan-out and tenant isolation.

## Phase 5 acceptance

- **Network:** a contacts CRM for creators, editors, curators and press.
  - Handles are normalised and deduplicated by email or handle.
  - Contacts carry audience, genres, rate and a relationship stage, which logged interactions move along. Do-not-contact blocks outreach.
  - Account checks record verified or gone; gone accounts stay visible for audit.
  - Playlists are recorded with their curators.
- **Marketing:**
  - Campaigns are tied to a release, with budget, dates, status and KPIs. KPIs are measured from the tracker (streams), bookings (views and posts) and accepted pitches (adds), or entered by hand.
  - Each campaign shows its stream delta: plays during the campaign versus the same number of days before it started.
  - Pipeline boards (creator, editor, playlist, custom) use Kanban with drag between stages. Creator cards are the booking ledger: offer, payment, posts ordered and delivered, proof links and measured views. Recording money needs `marketing:spend`.
  - Paid spend can't be deleted.
  - The outreach tracker drafts pitches and sends them through the worker over SMTP, at most once (approved → sending → sent). Each send is logged in the contact's history.
  - Sketchboards are a canvas with notes, references and milestones, with autosave and version conflict detection.
  - The Marketing overview matches the design ("what needs doing, most money first"), computed from the ledger. A full bookings CSV is available.
  - Live campaigns mark their tracks active for 6-hourly stream polling through the `stream-tier` enrich hook.
  - Agent tools: `network_*` (3) and `marketing_*` (6). Sending outreach always needs approval.
- **Bug fixed across modules:** Zod's `.partial()` keeps defaults, so PATCH requests silently reset fields such as release status or artist payout method. Every patch schema now uses `patchOf()` from `@labelconsole/core/zod`, with regression tests.
- **Tests:** 74 passing.

## Phase 6 acceptance

- **Agent types:** 8 types (Label Manager, Playlist & Editor Outreach, Creator Outreach, Trend & Social Monitor, A&R Scout, Stream Watch, Release Ops, Contract & Statement Watch). Each sets the tools, role, approval policy, budget, step limit, default triggers and what the final answer must cover. Agents are created from a type and then edited in the builder.
- **Permissions:** an agent acts as a role, capped by its owner's permissions and, for delegated work, its parent run's. Permissions are frozen when the run starts, so later role changes don't widen a run in flight.
- **Runtime (`agents.run` on the `agents` queue):**
  - A run claims a lease under a per-org advisory lock, which enforces the concurrency limit. It heartbeats and checkpoints after every step.
  - A crashed worker's run is picked up by the next attempt, or by the tick's stalled-run recovery. It resumes from the checkpoint.
  - The system prompt and tool list are frozen per run.
  - Tool calls carry idempotency keys, so a side effect never repeats after a crash. A non-idempotent call that was in flight is reported back to the agent as "may already have run".
  - Calls are rate-limited and time out, and transient errors are retried.
  - Context is compacted when it grows large. Claude's web search is offered only when the agent allows web research.
- **Approvals:** risk policy (`read`/`write`/`external`/`destructive`/`spend` → do / ask / deny), per-tool overrides, and tools that always ask (sending outreach, roster status). Staff approve, edit then approve (the edit is validated against the tool's schema), or reject with a reason the agent reads. Approvals expire, and the run resumes either way. The queue is on Inbox → Approvals and on the run page, with a live count in the top bar.
- **Budgets:** per run (summed across the delegation tree), per agent per day, and a label-wide monthly cap (Settings → Workspace). Checked before each model call, so a run stops before overspending (`budget_exceeded`).
- **Delegation:** `agents_delegate_task` starts a child run and parks the parent in `waiting_child` until the child finishes. The child can only do what both agents may do. The plan tree is shown on the run page.
- **Memory:** facts, outcomes and preferences per agent or shared by all agents. Duplicates bump importance. Staff can add, correct and delete memories on Agents → Memory.
  - **Hybrid recall:** semantic similarity × 4 + full-text rank × 4 + importance + recency.
  - **Embeddings:** Voyage AI (`voyage-4`, 1024 dimensions), using the label's own key from Settings → Integrations or the platform `VOYAGE_API_KEY`. New and corrected memories are embedded by a background job (`agents.embed-memories`) shortly after commit, with a 15-minute sweep as backstop.
  - **Model changes:** each vector records the model that made it (migration `0002`). After a model change everything is re-embedded, and vectors from another model are never compared.
  - **Fallback:** without a key, or when Voyage fails, recall falls back to full-text search.
  - **Status:** the Memory page shows whether semantic recall is on and how much is embedded.
- **Triggers:**
  - Cron schedules with timezone, fired by `agents.tick` every minute. The tick also recovers stalled runs and expires approvals.
  - Domain events, through a `*` listener that ignores agent and inbox events and an agent's own actions.
  - Signed inbound webhooks at `/api/webhooks/agents/[token]`. The token is stored hashed and shown once, and requests are rate-limited and capped at 64KB.
- **Control:** pause, resume and stop per run (stop cascades to child runs and aborts in-flight work via Redis control messages), plus a label-wide kill switch.
- **UI:**
  - Agents list with the kill switch, and a "no API key" banner when no model key is configured.
  - New-agent type gallery.
  - Agent page with triggers, recent runs and the builder (model, effort, role, approvals, tools, budgets, limits).
  - Runs list with cost per day, and a live run view (steps, reasoning summaries, tool inputs and results, approvals, plan tree, controls).
  - Memory and Usage pages (month vs cap, projection, per-agent cost).
  - Inbox → Approvals, with a placeholder when Agents isn't on the plan. The page router now matches only enabled modules, and fallback pages lose ties.
- **Without a model key:** runs fail at their first step with "No Anthropic API key is configured…". Nothing is simulated.
- **Tests:** 88 passing. Prompt tests check that webhook payloads are fenced as untrusted data. `modules/agents/agents.int.test.ts` uses a stub provider (test-only, via `setLlmProviderFactory`) to cover:
  - the loop, memory and the frozen prompt
  - approve, edit and reject
  - crash recovery with the lease and idempotency
  - budgets, the step limit, the kill switch, and pause/resume
  - delegation
  - cron and event triggers
  - the owner permission cap

## Phase 7 acceptance

- **Load test with many concurrent agents** (`pnpm test:load`):
  - Many labels' agents run through the real worker, queues, runtime and tools; only the model is a stub, with 60–180 ms latency.
  - 400 runs across 40 labels finished in about 16 s on one worker process (32 agent slots).
  - No label exceeded its concurrency limit, no model call or tool side effect repeated, and API reads stayed under 45 ms p95.
  - Finding fixed: runs that hit a label's limit backed off a fixed 10 s; the backoff is now 1.5–4 s with jitter, which took the worst queue wait from 11.6 s to 2.7 s.
- **Backups and restore drill** (`pnpm db:backup`, `pnpm db:restore-drill`):
  - The dump is taken from an exported snapshot, with a manifest of row counts from that same snapshot.
  - The drill restores into a scratch database and checks the checksum, row counts table by table, migrations, row-level security for the app role, and that every vault key and credential decrypts.
  - Verified passing, and verified failing (exit 1) with the wrong master key.
- **Observability:**
  - `/api/metrics` (Prometheus, token-protected, aggregates only): queues, worker heartbeats, outbox lag, job throughput, failures and durations, agents, streams and documents.
  - `/api/health?deep=1` adds worker liveness and outbox lag.
  - A Grafana dashboard and Prometheus alert rules are in `infra/`.
- **Billing:**
  - Plan tiers gate modules.
  - Per-plan limits on seats (invitations count), tracked tracks and file storage are checked when something is added, under an advisory lock so concurrent adds can't both take the last slot.
  - Over the tracking limit, new tracks wait and are added automatically once there is room.
  - Settings → Plan & usage shows each limit. No payment provider: the owner is the only user for now.
- **Onboarding:**
  - New labels get a getting-started checklist on the dashboard. Each module contributes its own step: label details, team, artists, a release, a contract or statement, YouTube, an agent.
  - The checklist can be hidden, and brought back from Settings.
- **Dev seed:** `LC_DEV_SEED=1 pnpm db:seed` creates a sample label through the real services. It refuses without the flag and always refuses in production. It invents no stream readings.
- **Docker:**
  - The `Dockerfile` builds web (Next standalone) and worker images: the worker bundle plus only its runtime packages, 431 MB.
  - `docker-compose.yml` runs the full stack. Verified: a fresh stack comes up healthy, sign-up and catalogue writes work, and the containerized worker processes their events.
- **Docs:** `docs/label-console-plan.md` (the spec), `docs/architecture-findings.md`, `docs/operations.md`, `README.md`.
- **Security fixes from the new module tests:**
  - **Role escalation:** anyone with `settings:members` could promote people (including themselves) to admin, or demote and remove people with more access. Roles can now only be handed out, changed or removed within the actor's own access, the same rule custom roles already followed.
  - **Activity feed leaks:** the feed showed Settings entries (invites, role changes, credentials) to anyone with `settings:read`, and the titles of confidential contracts and statements to anyone with `documents:read`. Audit entries can now carry a read permission (new `read_permission` column, migration `0001`); Documents sets it, and Settings entries need `settings:audit`.
  - **Uploads could crash the process:** a file rejected mid-stream (content not matching its type, or too large) raised an uncaught exception, which takes a Node process down. It's now a 422.
- **Bugs found and fixed while hardening:**
  - **Leaking queue connections:** BullMQ queues kept their Redis connections open, so scripts never exited and worker shutdown waited for its force-exit timer.
  - **Worker failed outside the monorepo:** the bundle imported packages the worker never declared, and pulled React and Next in through the UI index.
  - **Stale event triggers:** events that happened before an agent's trigger existed could start it, because outbox delivery is asynchronous.
  - **Doomed runs:** runs were queued with no model key configured and could only fail.
  - **Permission typo:** a page checked a permission no module declares. A test now scans for undeclared permission keys.
  - **Broken links:** some links pointed at `/settings/workspace`.
- **Anthropic workspace keys:** personal keys that span several workspaces need a workspace to bill. Set `ANTHROPIC_WORKSPACE_ID` (platform), or the Workspace ID field on the label's Anthropic integration, and every request carries the `anthropic-workspace-id` header.
- **Tests:** 125 passing, including semantic memory (embedding, re-embedding, fallback, stale-write protection) and the Voyage client contract. Also the load test and the restore drill.

## Next steps

1. Allow `spotscraper.readme.io`, `api.spotscraper.com` and `api.voyageai.com` in the environment's network access, then build the SpotScraper integration from its docs.
2. Decide the open items below; each has its integration point ready.
3. Run the restore drill and the load test against staging infrastructure, and record the numbers in `docs/operations.md`.
4. Set real plan limits in `packages/core/src/plans.ts` once pricing is decided.

## Open decisions

These need the owner. Nothing paid was added without asking.

- **Spotify data: SpotScraper (decided by the owner).** It will supply play counts, track credits and ISRC lookup through the licensed-source adapter (`modules/streams/sources/licensed.ts`) and metadata resolution. **Blocked:** the environment's network policy denies `spotscraper.readme.io` and `api.spotscraper.com`, so neither the docs nor the API can be read, and nothing is built from guesses.
- **API keys:**
  - **Anthropic:** the key is in place but needs a workspace ID (`wrkspc_…`), or a workspace-scoped key.
  - **Voyage AI:** needed for semantic memory, and `api.voyageai.com` must be allowed.
  - **YouTube Data API:** needed for stream polling.
- **Real plan limits.** No payment provider is needed while the owner is the only user. Limits are placeholders in `packages/core/src/plans.ts`.
- **Error tracking and tracing** (Sentry, or an OpenTelemetry backend such as Grafana Tempo or Honeycomb). Metrics, dashboards and alerts are in place.
- **Spotify Web API extended access**, or rely on Deezer, MusicBrainz and Apple for metadata (current default).
- **Outreach channels for agents** beyond email; most social platforms restrict automated DMs.
- **Artist portal** logins (a later phase in the spec).

## Running locally

See the [README](../README.md) for setup, and [operations.md](operations.md) for deploying.

```
pnpm install
pnpm db:setup && pnpm db:migrate     # needs Postgres 16 with pgvector, plus Redis
LC_DEV_SEED=1 pnpm db:seed           # optional sample label
pnpm dev                             # web on http://localhost:3000 and the worker
pnpm test
```
