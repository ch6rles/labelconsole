# Label Console — build progress

> **Current position:** Phases 1–6 are done. Phase 7 (hardening, docs, deploy) is next.
> If work pauses again, resume from **"Next steps"** below and carry on through the phases in order.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: pnpm monorepo, core platform (tenancy + RLS, auth/sessions, permissions, vault, audit, outbox events, BullMQ queues, worker service, SSE realtime, storage), design system, console shell | Done |
| 2 | Catalogue + in-house metadata lookup (`POST /v1/metadata/resolve`, distributor inference, bulk import, demos + public intake) | Done |
| 3 | People, Drive, Documents (contracts with AI term review, statements, royalties, key dates) | Done |
| 4 | Streams (YouTube Data API adapter, statement-import adapter, licensed-provider interface, snapshots, rollups, alerts) | Done |
| 5 | Network (contacts, interactions, playlists) + Marketing (campaigns, pipeline boards, outreach, sketchboards) | Done |
| 6 | Agent system (orchestrator, checkpointed runtime, tools, memory, triggers, approvals, budgets, delegation, kill switch, 8 agent types) + Inbox approvals page | Done |
| 7 | Hardening: dev seed, docs (`label-console-plan.md`, `architecture-findings.md`, README), Dockerfiles, full test run, screenshots, push | **Next** |

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
- **Memory:** facts, outcomes and preferences per agent or shared by all agents. Recall is Postgres full-text rank × 4 + importance + recency, and duplicates bump importance. Staff can add, correct and delete memories on Agents → Memory. The pgvector column stays empty until an embedding provider is chosen.
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

## Next steps (resume here)

1. **Phase 7 hardening.**
   - Dev seed behind `LC_DEV_SEED=1` (sample label, releases, contacts, campaigns, agents). Never runs in production.
   - Write `docs/label-console-plan.md`, `docs/architecture-findings.md` and the README.
   - Dockerfiles for web and worker, plus deploy notes.
   - Full test run, typecheck and `next build`; desktop and mobile screenshots.
   - Final progress update and push.

## Open questions for the owner

- The licensed stream-data vendor hasn't been chosen yet. Only the provider interface exists (`modules/streams/sources/licensed.ts`); the plan says to ask before adding a paid service.
- YouTube polling needs a YouTube Data API key: either the label's own (Settings → Integrations) or a platform `YOUTUBE_API_KEY`. The default quota is 10,000 units per day per Google project.
- No paid embedding provider is used. Memory uses a pgvector column with a Postgres full-text-search fallback.
- Agents need an Anthropic API key, either the label's own (Settings → Integrations) or a platform `ANTHROPIC_API_KEY`. Contract term extraction and statement PDF reading need it too.

## Running locally

```
pnpm install
pnpm db:setup && pnpm db:migrate     # needs Postgres 16 with pgvector, plus Redis
pnpm --filter @labelconsole/web dev  # http://localhost:3000
pnpm --filter @labelconsole/worker dev
pnpm test
```
