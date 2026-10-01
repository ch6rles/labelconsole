# Label Console — build progress

> **Current position:** Phases 1–3 are done. Phase 4 (Streams) is next.
> If work pauses again, resume from **"Next steps"** below and carry on through the phases in order.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: pnpm monorepo, core platform (tenancy + RLS, auth/sessions, permissions, vault, audit, outbox events, BullMQ queues, worker service, SSE realtime, storage), design system, console shell | Done |
| 2 | Catalogue + in-house metadata lookup (`POST /v1/metadata/resolve`, distributor inference, bulk import, demos + public intake) | Done |
| 3 | People, Drive, Documents (contracts with AI term review, statements, royalties, key dates) | Done |
| 4 | Streams (YouTube Data API adapter, statement-import adapter, licensed-provider interface, snapshots, rollups, alerts) | **Next** (schema + manifest exist) |
| 5 | Network (contacts, interactions, playlists) + Marketing (campaigns, pipeline boards, outreach, sketchboards) | Not started (schema + manifest only) |
| 6 | Agent system (orchestrator, checkpointed runtime, tools, memory, triggers, approvals, budgets, delegation, kill switch, 8 agent types) + Inbox approvals page | Not started (schema + manifest; Inbox and Settings are done) |
| 7 | Hardening: dev seed, docs (`label-console-plan.md`, `architecture-findings.md`, README), Dockerfiles, full test run, screenshots, push | Not started |

## Phase 3 acceptance

- Upload a contract and Claude reads its terms in the worker (`documents.extract`). Nothing is applied until a person reviews and confirms the terms on the document page; confirming creates the key dates (options, notices, expiry) and links the artists named as parties.
- Statements (distributor CSV, or PDF read by Claude) are parsed into `statement_lines`, matched to tracks by ISRC and UPC, and summarised with anomaly checks against the previous statement.
- Finance → Royalties shows 12 months of booked revenue, the split by source, and top releases for the latest booked period, with artist and label shares taken from confirmed contract terms. Revenue without confirmed terms is shown as "not yet split", never guessed. CSV export is included.
- Confidential documents and statements are hidden from roles without `documents:read_confidential` / `documents:read_financial`, and every view of a confidential document is logged. Covered by `modules/documents/documents.int.test.ts`.
- Tests: 50 passing (unit and integration).

## Next steps (resume here)

1. **Phase 4 Streams**:
   - track registry listener on `catalogue.track.imported` and `catalogue.track.created`
   - YouTube resolver and YouTube Data API adapter
   - statement-import adapter (from `documents.statement.parsed`)
   - licensed-provider interface (no vendor chosen)
   - snapshots into the partitioned table, daily rollups, alert rules
   - scheduler and partition maintenance
   - `/v1/streams/...` endpoints, UI, agent tools, dashboard stats, panels
2. **Phase 5 Network + Marketing.**
3. **Phase 6 Agents**: runtime, triggers, approvals UI, tests with the stubbed provider (`setLlmProviderFactory`).
4. **Phase 7**: dev seed, docs, Dockerfiles, full verification.

## Open questions for the owner

- The licensed stream-data vendor hasn't been chosen yet. Only the provider interface exists; the plan says to ask before adding a paid service.
- No paid embedding provider is used. Memory uses a pgvector column with a Postgres full-text-search fallback.

## Running locally

```
pnpm install
pnpm db:setup && pnpm db:migrate     # needs Postgres 16 with pgvector, plus Redis
pnpm --filter @labelconsole/web dev  # http://localhost:3000
pnpm --filter @labelconsole/worker dev
pnpm test
```
