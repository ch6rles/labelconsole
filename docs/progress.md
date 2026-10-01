# Label Console — build progress

> **RESUME MARKER — paused 2026-10-01.** Work stopped partway through **Phase 3**:
> the Documents module backend is done and typechecks, but its UI pages haven't been written yet.
> When work resumes, start at **"Next steps"** below and then carry on through Phases 4–7 in order.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: pnpm monorepo, core platform (tenancy + RLS, auth/sessions, permissions, vault, audit, outbox events, BullMQ queues, worker service, SSE realtime, storage), design system, console shell | Done |
| 2 | Catalogue + in-house metadata lookup (`POST /v1/metadata/resolve`, distributor inference, bulk import, demos + public intake) | Done |
| 3 | People, Drive, Documents | **In progress.** People and Drive are done. Documents backend is done; Documents UI is next |
| 4 | Streams (YouTube Data API adapter, statement-import adapter, licensed-provider interface, snapshots, rollups, alerts) | Not started (schema + manifest only) |
| 5 | Network (contacts, interactions, playlists) + Marketing (campaigns, pipeline boards, outreach, sketchboards) | Not started (schema + manifest only) |
| 6 | Agent system (orchestrator, checkpointed runtime, tools, memory, triggers, approvals, budgets, delegation, kill switch, 8 agent types) + Inbox approvals page | Not started (schema + manifest; Inbox and Settings are done) |
| 7 | Hardening: dev seed, docs (`label-console-plan.md`, `architecture-findings.md`, README), Dockerfiles, full test run, screenshots, push | Not started |

## Phase 3 — where Documents stands

Done (in `modules/documents/`):
- `schema/`: documents (with versioning), links, key dates, statement lines, access log
- `statements.ts`: CSV statement parsing, column mapping and anomaly summary
- `extract.ts`: contract-terms and statement-line schemas and prompts
- `service/`: upload and versions, list and read (enforcing confidential and financial access), terms confirmation that creates key dates, key dates, contract status labels, royalties, earnings by artist
- `jobs/`: `documents.extract` (Claude reads the PDF), `documents.parse-statement`, daily `documents.reminders` fan-out
- `api/`: routes for documents, versions, download, extract, confirm-terms, links, key dates, `/finance/royalties` and `/finance/statements`
- `agent-tools/`: documents_read, documents_extract_terms, documents_summarize_statement, documents_upcoming_dates
- `server.ts`: schedules, widgets, attention items, search, and People enrichment
- `packages/core/src/usage.ts`: usage counters, plus the LLM provider resolved from the vault key or env

## Next steps (resume here)

1. **Documents UI** in `modules/documents/ui/`, registered in `modules/documents/web.ts`:
   - `/documents`: list, upload and filters
   - `/documents/:id`: preview and download, versions, access log, and the review/edit/confirm form for extracted terms
   - `/documents/key-dates`
   - `/people/contracts`: matches the design table (ARTIST · AGREEMENT/Covers · TYPE · TERM · ROYALTY · STATUS · DATE)
   - `/finance/royalties`: matches the design (fin cards, 12-month booked `BarChart`, by-source `ShareBars`, top earning releases)
   - `/finance/statements`: imported distributor statements, with summary, lines and anomalies
   - Panels: artist "Contracts & documents" and release "Documents"
2. Tests: unit tests for `parseStatementCsv` and `summarize`, and an integration test for `confirmTerms` → key dates plus confidential access. Then run `pnpm typecheck`, `pnpm test` and a web typecheck, and commit.
3. **Phase 4 Streams**: track registry listener; YouTube resolver and Data API adapter; statement-import adapter; licensed-provider interface; snapshots, rollups and alerts; scheduler and partition maintenance; `/v1/streams/...` endpoints; UI; tools; stats; panels.
4. **Phase 5 Network + Marketing.**
5. **Phase 6 Agents**: runtime, triggers, approvals UI, tests with the stubbed provider (`setLlmProviderFactory`).
6. **Phase 7**: hardening and delivery.

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
