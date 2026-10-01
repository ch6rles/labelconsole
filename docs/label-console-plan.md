# Label Console — Build Plan & Implementation Prompt

*Oct 1, 2026*

> This is the spec the build follows, exported from the planning document. The master
> implementation prompt near the end points here as the source of truth. Wording is kept
> as written; only the layout was converted to Markdown.

## Overview

Label Console is a multi-tenant SaaS that gives a record label one workspace for its catalogue, roster, marketing, documents, files, live stream data and autonomous AI agents. Every tool is built as a self-contained module so it can be developed, tested, permissioned and shipped on its own, then slotted into the console shell.

Guiding principles:

- **Compartmentalized modules.** Each module owns its routes, UI, API handlers, database tables, background jobs and agent tools. Modules talk to each other only through typed service interfaces and domain events, never by reaching into each other's tables.
- **Production foundation, not mocks.** Real auth, real queues, real data sources. Where a data source is not legally or technically available, the plan says so and uses an adapter so a compliant provider can be swapped in.
- **Multi-tenant from day one.** Every row belongs to an organization (a label); a user can belong to several labels with a different role in each.
- **Agents are first-class users of the platform.** Anything a staff member can do through the UI, an agent can do through the same service layer, under the same permissions, with approvals for risky actions.
- **Reuse before replace.** If a codebase already exists, the build inspects it first and reuses its auth, database, API, UI and deployment patterns.

The master prompt to hand to Claude Code is in the [Master implementation prompt](#master-implementation-prompt) section near the end; everything above it is the spec that prompt points to.

## Architecture and stack

The console is a web app plus a separate, always-on worker service that shares one Postgres database and one Redis instance, so agents and trackers keep running when nobody is logged in.

*System architecture: web app, data layer, workers, external services.*

The web app never does long work inside a request; it writes to Postgres, enqueues a job in Redis and returns. Workers pick up jobs, call external services, write results back and publish events, which the realtime gateway pushes to open browsers.

Default stack (if the repo is new; otherwise reuse what exists):

| Layer | Choice | Why |
|---|---|---|
| Frontend and API | Next.js (App Router) with TypeScript | One codebase for UI and API routes; good fit for the design import |
| Database | Postgres with Drizzle or Prisma, row-level security | Relational data, JSONB for flexible fields, RLS for tenant isolation |
| Queue and scheduler | Redis with BullMQ (repeatable jobs, retries, rate limiters) | Durable background jobs with backoff and concurrency control |
| Workers | Node service in the same monorepo, deployed as its own process | Shares types and module services with the web app |
| Realtime | Server-Sent Events or WebSockets fed by Redis pub/sub | Live agent logs and stream alerts |
| File storage | S3-compatible (Cloudflare R2 or AWS S3) with signed URLs | Audio, artwork, contracts, Drive files |
| Auth | Existing auth, or Auth.js / Clerk if starting fresh | Org-aware sessions |
| Observability | Structured logs, OpenTelemetry traces, Sentry | Debugging agents and jobs across processes |

Repo layout: `apps/web`, `apps/worker`, `packages/core` (auth, tenancy, events, credentials, tool registry), `packages/ui` (design tokens and primitives), `modules/*` (one folder per module, imported by both apps).

Deployment note: serverless hosts such as Netlify or Vercel can serve the web app, but the worker service must run on a host that keeps processes alive (Railway, Fly.io, Render, or containers on AWS/GCP).

## Design implementation

The UI comes from the Claude Design project, imported through the `claude_design` MCP and implemented as the console shell plus a shared component library that every module uses.

Design import instructions (use verbatim in Claude Code):

> Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, auth via /design-login) to import this project:
> https://claude.ai/design/p/75f7363c-a100-4c90-b8ed-41454917f724?file=Label+Console.dc.html
>
> Focus on these files (the whole project is readable):
> - `Label Console.dc.html`
>
> Also read these files the selection imports:
> - `support.js`
>
> Implement: `Label Console.dc.html`

How the design maps into the codebase:

1. **Extract tokens first.** Pull colors, type scale, spacing, radii, shadows and motion from `Label Console.dc.html` into a single tokens file (CSS variables plus a Tailwind theme if Tailwind is used). No module hard-codes a color or size.
2. **Build the shell.** Sidebar navigation, top bar, label switcher, command palette, notifications tray and the agent activity indicator become one layout component. Each module registers its nav entry rather than editing the sidebar by hand.
3. **Port `support.js` behavior** into typed React hooks or utilities. Do not ship it as a global script.
4. **Build shared primitives the design implies:** data table, detail drawer, status pills, stat cards, charts, kanban board, file grid, form controls, empty and loading states. Modules compose these.
5. **Fill screens the design doesn't show** using the same primitives and tokens, so new modules look native without new design work.
6. **Check parity.** Compare the built shell against the design file at desktop and mobile widths before building module screens on top of it.

## Module map

The console ships as ten modules. Each lives in its own folder (`modules/<name>`) with its own UI routes, API, schema, jobs, events and agent tools, and registers itself with the shell through a manifest.

| Module | Scope | Key features | Agent tools it exposes |
|---|---|---|---|
| Catalogue | Releases, tracks, demos, assets | Release and track records, versions and stems, artwork, credits and splits, demo inbox with A&R scoring, ISRC/UPC/distributor auto-lookup on import, release checklist | search catalogue, get track, create release draft, score demo |
| People | Artists and staff | Artist profiles with status (prospect, signed, alumni), linked contracts, releases and auto-tracked streams; staff directory with roles and module permissions | get artist, list roster, update artist status (approval) |
| Network | Creators, editors, curators, playlists | Contact CRM for creators, playlist editors and press; platform handles, audience size, genres, rates, contact history, relationship stage | find contacts, add contact, log interaction |
| Marketing | Campaigns and planning | Campaign builder tied to releases, budget and KPIs, creator/editor pipelines as kanban boards, playlist outreach tracker, marketing sketchboard (freeform canvas of notes, refs, timeline) | create campaign, move pipeline card, draft outreach |
| Documents | Contracts and statements | Upload, version, tag and link to artists/releases; AI extraction of contract terms (term, territory, splits, options) and statement line items; expiry and option-date reminders | read document, extract terms, summarize statement |
| Drive | Label file storage | Folders, sharing, previews, search, per-folder permissions, links to any record; optional Google Drive connector that syncs or mirrors folders | list files, read file, save file |
| Streams | Live stream analytics | Per-track and per-artist Spotify and YouTube Music counts over time, deltas, playlist adds, alerts on spikes or drops; fed by the tracking service | get stream history, get top movers |
| Agents | Autonomous AI agents | Create, plan, run, pause, stop, edit agents; schedules and triggers; live activity log; approvals inbox; cost and token usage | n/a (this is the runtime) |
| Inbox and activity | Platform-wide | Notifications, approvals queue, activity feed, mentions | notify user, request approval |
| Settings and admin | Org-level | Label profile, members and roles, integrations, credentials vault, billing, audit log, data export | none (agents never get admin tools) |

Module contract every module follows:

- `manifest.ts`: name, nav entries, permissions it defines, events it emits and listens to, agent tools it registers.
- `schema/`: its own tables, all with `org_id`.
- `service/`: the only way other modules or agents touch its data.
- `api/`: HTTP routes that call the service layer.
- `jobs/`: queue handlers it owns.
- `ui/`: pages and components built from the shared design primitives.

Turning a module off for a plan tier or a label hides its nav, rejects its routes and unregisters its agent tools, without touching other modules.

## Core data model

Every table carries `org_id`, `created_at`, `updated_at` and `created_by` (a user or an agent). Cross-module links use IDs and events, not foreign keys into another module's private tables, except for the shared core entities below.

| Entity | Owned by | Key fields and links |
|---|---|---|
| Organization | Core | name, slug, plan, settings |
| Membership | Core | user, org, role, module permissions |
| Artist | People | name, aliases, status, socials, Spotify artist ID, YouTube channel ID, contracts, releases |
| StaffMember | People | user link, title, department, permissions |
| Release | Catalogue | title, type, UPC, release date, label, distributor, status, artwork asset, artists |
| Track | Catalogue | title, ISRC, duration, version, explicit, credits, splits, release links, platform IDs (Spotify track, YouTube video) |
| Demo | Catalogue | submitter, audio asset, notes, A&R score, stage |
| PlatformIdentity | Catalogue | track or release, platform, external ID, URL, confidence, source of match |
| StreamSnapshot | Streams | track, platform, captured_at, count, source (partitioned by month) |
| Contact | Network | type (creator, editor, curator, press), handles, audience, genres, rate, stage |
| Interaction | Network | contact, channel, direction, summary, campaign, agent or user |
| Campaign | Marketing | release, goals, budget, KPIs, date range, status |
| PipelineCard | Marketing | board, stage, contact, campaign, due date, owner |
| SketchBoard | Marketing | campaign, canvas JSON, collaborators |
| Document | Documents | type (contract, statement, other), file, parties, linked artist/release, extracted terms JSON, key dates |
| File and Folder | Drive | path, storage key, size, mime, permissions, external Drive ID |
| Agent | Agents | type, goal, instructions, model, tools, permissions, budget, schedule, triggers, status |
| AgentRun, AgentStep, AgentMemory, Approval | Agents | see the agent system section |
| Credential | Core | provider, encrypted secret, scope, owner org; never returned to the client |
| AuditLog | Core | actor (user or agent), action, target, before/after, timestamp |

## Stream tracking service

Build an in-house Stream Tracking API with pluggable data-source adapters: YouTube Music counts can come straight from YouTube's official API, but Spotify stream counts must come from a licensed data provider, because Spotify's official API does not expose them and its terms block the obvious workarounds.

What each platform actually allows (checked October 2026):

- **Spotify.** The Web API has never returned stream counts, and its February 2026 changes also removed track, album and artist `popularity`, artist `followers`, album `label`, and the batch "Get Several Tracks/Albums/Artists" endpoints for Development Mode apps (Spotify changelog). Development Mode is licensed for private personal use, prohibits ingesting Spotify Content into an AI model, prohibits robots or scrapers, and prohibits storing compilations of Spotify Content beyond what the app strictly needs (Spotify Developer Terms v10). A commercial SaaS therefore needs Spotify extended access or a separate agreement before relying on the Web API at all, and scraping play counts from Spotify's apps is excluded from this build.
- **YouTube Music.** YouTube Music plays of a release surface as views on its YouTube videos (the auto-generated "Topic" art tracks and official videos). The YouTube Data API v3 `videos.list` returns `statistics.viewCount`, costs 1 quota unit per call, and accepts up to 50 video IDs per call, against a default of 10,000 units per project per day (Google quota table). `search.list` costs 100 units, so search once to map a track to its video IDs, store the IDs, and only poll `videos.list` afterwards.

Service design:

1. **Track registry.** When a track enters the catalogue, the service registers it with its ISRC and any known platform IDs. A resolver job maps it to YouTube video IDs (topic channel art track first, then official video) and to the licensed provider's track ID by ISRC. Low-confidence matches go to a human review queue.
2. **Provider adapters.** One interface, `StreamSource.fetch(trackRefs[]) → Snapshot[]`, with adapters for: `youtube-data-api` (official, view counts), `licensed-provider` (Spotify and other DSP stream counts from a vendor such as Chartmetric, Songstats or Soundcharts, chosen after a pricing and terms review), and `statement-import` (exact counts parsed from distributor statements in the Documents module, the label's ground truth).
3. **Scheduler.** A repeatable queue job per org polls on a tier-based interval (for example every 6 hours for active campaigns, daily for back catalogue), batching 50 YouTube IDs per call and respecting each provider's rate limits with a token bucket in Redis.
4. **Snapshot store.** Append-only `stream_snapshots` (track, platform, source, captured_at, count), partitioned by month or stored in TimescaleDB, with daily rollups for charts. Each row records which adapter produced it, so licensed, official and statement figures are never mixed silently.
5. **Internal API.** `GET /v1/streams/tracks/:id?platform&from&to&granularity`, `GET /v1/streams/artists/:id`, `GET /v1/streams/movers?window=7d`, plus a webhook and domain event `streams.snapshot.recorded` that Marketing, People and Agents subscribe to.
6. **Alerts.** Rules on deltas (spike, drop, milestone crossed) emit `streams.alert` events that can notify staff or trigger an agent run.

**Agent rule:** agents receive stream data through the Streams service's own tool (derived numbers from YouTube, licensed providers and statements). Raw Spotify Web API responses are never placed in an LLM prompt, to stay inside Spotify's no-AI-ingestion term.

## Metadata lookup service

ISRC and UPC can be resolved reliably from public catalogue APIs; distributor cannot, because no DSP publishes it as a field, so the service infers it from evidence and shows a confidence score for a human to confirm.

**Endpoint:** `POST /v1/metadata/resolve` with any one of: a Spotify, Apple Music, Deezer or YouTube link; an ISRC; a UPC; title plus artist; or an uploaded audio file's embedded tags. It returns ISRC, UPC, title, artists, release date, label name, platform IDs per DSP, and `distributor: {name, confidence, evidence[]}`.

Sources, queried in parallel and merged:

| Source | Gives | Notes |
|---|---|---|
| Deezer public API | ISRC per track, UPC and label per album, lookup by ISRC or UPC | No auth; roughly 50 requests per 5 seconds (reference); review Deezer's API terms for commercial use |
| Spotify Web API | Track ISRC and album UPC via `external_ids`, album copyright lines | `external_ids` removal was reverted in March 2026, but album `label` is gone in Development Mode (changelog); needs extended access for a commercial product |
| MusicBrainz | ISRC to recording, release barcodes, label relationships | Open data; 1 request per second rate limit with a descriptive User-Agent |
| Apple Music / iTunes lookup | ISRC, UPC, label and copyright | Apple Music API needs a developer token |
| Licensed data provider | Distributor and label fields where the vendor has them | Same vendor as stream tracking, if its plan includes this |

Distributor inference (heuristics, each adds evidence and weight):

1. A licensed provider's distributor field, if available (highest weight).
2. The label and P-line/C-line copyright text across DSPs, matched against a maintained table of distributor names and their default label strings.
3. The UPC's GS1 company prefix, matched against a prefix-to-distributor table the label builds up from confirmed releases.
4. MusicBrainz label relationships.

The UI shows the top guess with its evidence; a user's confirmation is stored and feeds the prefix and label tables so accuracy improves per label over time.

**Import flow:** paste or upload, then resolve, then show a review screen with any conflicts between sources highlighted, then on confirm create Release and Track records plus PlatformIdentity rows, then emit `catalogue.track.imported`, which the stream tracker picks up to start polling. Bulk import accepts a CSV of ISRCs or UPCs and runs as a background job with progress.

## Autonomous agent system

Agents are durable backend jobs: an Orchestrator turns triggers into runs, workers execute a checkpointed LLM reasoning loop against permission-filtered tools, and every step is stored and streamed to the UI, so runs survive crashes and continue while users are offline.

*Agent run lifecycle: plan, approve, execute, checkpoint.*

Core components (in `packages/core/agents` and `modules/agents`):

| Component | Responsibility |
|---|---|
| Orchestrator | Creates, starts, pauses, resumes, stops and monitors agents; turns triggers into runs; enforces concurrency caps per org; handles delegation between agents |
| Agent type registry | Each agent type declares default instructions, required tools, default approval policy and output schema; new types are added as files, not core changes |
| Runtime (worker) | Runs the reasoning loop for one run, checkpoints after every step, honors pause and stop signals between steps |
| Tool registry | Modules register tools with a JSON schema, required permission, risk level (read, write, external, destructive, spend), timeout, rate limit and idempotency rule |
| LLM provider layer | One interface for chat with tool calling, streaming and token usage; Anthropic Claude as the default provider, others pluggable; model chosen per agent |
| Memory | Short-term run context with automatic summarization when long, plus long-term memories (facts, outcomes, preferences) stored with embeddings in Postgres (pgvector) and retrieved by relevance |
| Triggers | Cron schedules, domain events such as a submitted demo, a stream alert or an approaching release date, inbound webhooks, manual runs, delegation from a manager agent |
| Approvals | Policy per agent and per tool risk level; risky calls create an Approval record, pause the run and notify the owner |
| Budget and cost | Token usage per step priced from a model price table; limits per run, per agent per day and per org per month |
| Event stream | Run and step events on the org's realtime channel |

Data model:

- `agents`: type, name, goal, instructions, model, tool allowlist, role, approval policy, budget, status (active, paused, archived), owner.
- `agent_triggers`: agent, kind (cron, event, webhook), config, next run time.
- `agent_runs`: agent, trigger, parent run (for delegation), status (queued, running, waiting_approval, waiting_child, paused, completed, failed, stopped, budget_exceeded), start and end times, tokens in and out, cost, result, error.
- `agent_steps`: run, index, kind (plan, tool_call, tool_result, message, approval, delegation), input, output, tokens, duration, idempotency key, checkpoint state.
- `agent_memories`: agent or org scope, kind, content, embedding, importance, source run, expiry.
- `approvals`: run, step, tool, human-readable preview of the action, payload, status, decided by, decided at, expiry.

Reasoning loop, per step:

1. Build the prompt from the agent's instructions, org context, relevant memories, a compacted history of earlier steps, and only the tools its role allows. No secrets and no raw Spotify API data go into the prompt.
2. Call the model. It returns either tool calls or a final answer.
3. For each tool call: validate arguments against the schema, check permission, apply the approval policy, then execute with a timeout, retries with backoff for transient errors, and the step's idempotency key so a retried email or post is never sent twice.
4. Store the step and result, update tokens and cost, publish the event, and check limits (steps, wall-clock time, budget) before the next step.
5. On a final answer, write the result, save new long-term memories, and emit a run-completed event.

**Multi-agent delegation:** a Manager agent has a `delegate_task` tool that creates a child run for a specialist agent and puts the parent in `waiting_child`. The child's completion event resumes the parent with the child's result. Delegated runs inherit the stricter of the two agents' permissions and draw on the parent's budget.

Reliability:

- Runs are queue jobs with a lease and heartbeat; a crashed worker's stalled job is re-queued and resumes from the last checkpoint, not from the start.
- Pause and stop write a desired state to the database and send a control message; the runtime checks it between steps. A hard kill aborts in-flight calls.
- Rate limits per tool, per provider and per org use Redis token buckets; provider 429 responses back off and reschedule instead of failing the run.
- Every run has a maximum step count and wall-clock timeout; every tool call has its own timeout.
- A kill switch per org stops all agents at once.

First agent types for the label:

| Agent | Goal | Triggers | Needs approval for |
|---|---|---|---|
| Label Manager | Break a label goal into tasks and delegate to specialists | Manual, weekly | Starting agents beyond budget |
| Playlist and Editor Outreach | Find fitting curators and editors for a release, draft personalized pitches, track replies | Release created, campaign started | Sending any message |
| Creator Outreach | Find creators who fit a song, draft offers, add them to the pipeline | Campaign started | Sending messages, offering money |
| Trend and Social Monitor | Watch roster accounts, sounds and hashtags; flag trends and editor activity | Every few hours | Posting anything |
| A&R Scout | Score new demos against the label's taste profile; surface emerging artists | Demo submitted, daily | Contacting artists |
| Stream Watch | Explain stream spikes and drops and alert the team | Stream alert event | Nothing (read-only) |
| Release Ops | Check release checklists, metadata gaps and deadlines | Daily in the weeks before a release | Editing catalogue metadata |
| Contract and Statement Watch | Flag option dates, expiries and statement anomalies | Document uploaded, monthly | Nothing (read-only) |

**Agents UI:** an agents list (status, current task, last and next run, cost today); an agent builder (goal, instructions, model, tools, permissions, approval policy, schedule and triggers, budget); a plan view showing a manager's task tree; a live run view streaming each step, tool call and result; an approvals inbox with approve, edit-then-approve and reject; a memory viewer where staff can correct or delete memories; and run history with cost charts.

## Security, multi-tenancy and permissions

One permission model governs humans and agents alike, and tenant isolation is enforced in the database, not only in application code.

- **Tenant isolation.** Every table has `org_id`. Postgres row-level security policies check `org_id` against the session's org, set per request and per job. Workers set the org context before touching data, so a bug in one handler cannot leak another label's rows.
- **Roles.** Owner, Admin, Manager, A&R, Marketing, Finance, Viewer, plus custom roles. Permissions are `module:action` strings (`catalogue:write`, `documents:read_financial`) that each module declares in its manifest.
- **Artist-scoped access.** Optional per-artist restrictions so a manager sees only their roster, and an artist portal login (later phase) sees only their own releases, streams and statements.
- **Agents as principals.** Each agent runs as a service principal with its own role, capped at the permissions of the user who created it. Its tool list is filtered by that role before the LLM ever sees it.
- **Credentials vault.** Third-party keys and OAuth tokens (Google, YouTube, data providers, email, social) are encrypted with envelope encryption (a KMS-managed key, per-org data keys). They are decrypted only inside the worker process that calls the API, never sent to the browser, never written to logs, and never placed in a prompt. Tools receive a credential handle, not the secret.
- **Sensitive documents.** Contracts and statements get a confidential flag, stricter permissions, signed short-lived download URLs, and access logging.
- **Audit log.** Every write by a user or agent records actor, action, target and a before/after diff. Agent actions also link to the run and step that caused them.
- **Platform hygiene.** Rate limits per org and per user, input validation on every route with shared schemas, CSRF and secure cookies, file type and size checks with virus scanning on upload, and GDPR-style export and delete per org.

## Build phases

Build in seven phases; each one ends with a working, deployable product and a short acceptance check before the next starts.

1. **Foundation.** Repo structure, auth, orgs and memberships, roles, RLS, credentials vault, audit log, queue and worker service, realtime channel, design tokens and console shell from the Claude Design import.
   *Done when:* two test labels cannot see each other's data; a background job runs on the worker with the browser closed; the shell matches the design file.
2. **Catalogue and metadata lookup.** Releases, tracks, demos, assets, credits and splits; the resolve endpoint and bulk import.
   *Done when:* pasting a DSP link or ISRC creates a release and track with ISRC, UPC and a distributor guess with evidence.
3. **People, Documents and Drive.** Artists, staff, contracts and statements with term extraction, file storage with folders and permissions, Google Drive connector.
   *Done when:* an artist page shows linked contracts, releases and files; an uploaded contract yields extracted key dates.
4. **Streams.** Track registry, YouTube adapter, statement-import adapter, licensed-provider adapter interface (vendor plugged in once chosen), snapshots, charts, alerts.
   *Done when:* an imported track shows a YouTube view history that updates on schedule without anyone logged in.
5. **Network and Marketing.** Contacts CRM, campaigns, pipelines, playlist outreach tracker, sketchboard.
   *Done when:* a campaign links a release, contacts and pipeline cards, and shows its stream deltas.
6. **Agent system.** Orchestrator, runtime, tool registry, memory, triggers, approvals, cost tracking, realtime activity UI, first three agent types (Monitor, Outreach, A&R Scout).
   *Done when:* a scheduled agent runs overnight, pauses for an approval, resumes after approval, survives a worker restart mid-run, and reports its token cost.
7. **Hardening.** Load tests with many concurrent agents, backups and restore drill, observability dashboards, billing, onboarding.

## Master implementation prompt

Paste the prompt below into Claude Code at the root of the repo. First export this doc as Markdown and save it in the repo as `docs/label-console-plan.md`, which the prompt treats as the full spec.

````markdown
# Build: Label Console — record label SaaS

You are the lead engineer building Label Console, a multi-tenant SaaS for
record labels. The full spec is in `docs/label-console-plan.md`. Read it
completely before writing code, and treat it as the source of truth. When
this prompt and the spec disagree, ask me.

## Step 0 — Inspect before building
1. Inspect the existing project: framework, auth, database and ORM, API
style, UI library, state management, deployment target, env handling, tests.
2. Write `docs/architecture-findings.md` summarising what exists and how you
will reuse it. Reuse the current auth, database, API, UI and deployment
patterns. Do not replace working functionality unnecessarily.
3. If the repo is empty, use the default stack in the spec's Architecture
section.
4. Show me the findings and a phase-by-phase file plan, then wait for my go-
ahead before Phase 1.

## Step 1 — Design
Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, auth via
/design-login) to import this project:
https://claude.ai/design/p/75f7363c-a100-4c90-b8ed-41454917f724?file=Label+Console.dc.html

Focus on these files (the whole project is readable):
- `Label Console.dc.html`

Also read these files the selection imports:
- `support.js`

Implement: `Label Console.dc.html`

Extract design tokens into one tokens file, build the console shell (sidebar,
top bar, label switcher, command palette, notifications, agent activity
indicator) and shared primitives, port `support.js` into typed
hooks/utilities, and check visual parity at desktop and mobile widths. Every
module UI must be built from these primitives and tokens.

## Step 2 — Modular architecture
Build every feature as a self-contained module under `modules/<name>` with
`manifest.ts`, `schema/`, `service/`, `api/`, `jobs/`, `ui/` and `agent-
tools/`. Modules communicate only through service interfaces and typed domain
events. Modules: Catalogue, People, Network, Marketing, Documents, Drive,
Streams, Agents, Inbox, Settings (see the Module map in the spec). Every
table has `org_id`, enforced with Postgres row-level security.

## Step 3 — In-house APIs
- **Metadata lookup** (`POST /v1/metadata/resolve`): resolve ISRC, UPC,
label, platform IDs and an evidence-based distributor guess with confidence
from Deezer, MusicBrainz, Spotify (only where our access level allows), Apple
and a licensed provider adapter. Follow the spec's Metadata lookup section.
- **Stream tracking** (`/v1/streams/...`): provider-adapter service with a
YouTube Data API adapter (videos.list viewCount, batched 50 IDs, never
search.list in polling), a statement-import adapter, and a licensed-provider
adapter interface for Spotify counts. Do NOT scrape Spotify or any DSP, and
never put raw Spotify API responses into an LLM prompt. Follow the spec's
Stream tracking section.

## Step 4 — Autonomous AI agent system
Implement a real autonomous AI-agent system. Agents run on the backend
independently of the user's browser and keep operating when the user is
offline.

Build it around an Agent Orchestrator that can create, start, stop, pause,
resume and monitor many agents. Each agent has a configurable goal and
instructions, persistent state, memory, tools, permissions, status, activity
history, and optional schedule and event triggers.

The architecture must support:
- Long-running background jobs on a reliable worker/queue system, not browser
execution.
- An LLM reasoning loop: evaluate state, decide the next step, call tools,
process results, continue toward the goal, stop on goal met, budget, step
limit or blocking approval.
- Tool/function calling against the application's service layer, database,
analytics, external APIs, web/research tools and other services, through a
tool registry that modules register into.
- Persistent agent memory and task history in the application database.
- Scheduled and event-driven execution (every X hours; on domain events such
as a new demo, a stream spike or a release date).
- Multiple specialized agents working together, including a manager agent
that plans and delegates subtasks to other agents.
- Real-time frontend updates of status, current task, activity logs,
completed actions, errors and results.
- Configurable permissions and approval requirements so destructive or
external actions (sending email or DMs, posting, spending, deleting, changing
contracts) require user confirmation.
- Error handling, retries with backoff, timeouts, rate limits, token and cost
tracking with per-agent and per-org budgets, and graceful recovery if an
agent or worker crashes (checkpoint every step; resume from the last
checkpoint).
- Secure credential storage. Never expose secrets to the frontend or to agent
prompts; tools receive credential handles.

It must scale to many concurrent agents without blocking the web app, and
stay modular so new tools, agent types, triggers and LLM providers can be
added without rewriting the core. Follow the spec's Autonomous agent system
section for the data model, run lifecycle and the first agent types.

## Rules
- Production-oriented foundation: no mocks, no simulated agents, no fake data
in production paths. Seed data only behind a dev flag.
- Long-running work never runs in serverless request handlers. Workers run as
a persistent service.
- Typed end to end; shared validation schemas between API and UI.
- Tests for every service: unit tests, plus integration tests for RLS
isolation, the agent loop (with a stubbed LLM provider in tests only),
approvals and crash recovery.
- Work phase by phase as listed in the spec's Build phases. At the end of
each phase: run tests, update `docs/progress.md` with what was built and how
to verify it against the phase's acceptance check, and stop for my review.
- Ask before adding paid third-party services or choosing the licensed
stream-data vendor.
````

## Open decisions and risks

The biggest risk is Spotify data access; the rest are product choices to settle before or during Phase 1.

- **Spotify stream data vendor.** Pick a licensed provider after comparing price per tracked track, refresh frequency, Spotify stream coverage and whether its terms allow use inside a SaaS and with AI agents.
- **Spotify Web API access.** Decide whether to apply for extended access or skip the Web API and rely on Deezer, MusicBrainz and the vendor for metadata.
- **"Built-in Google Drive" meaning.** Own file storage with a Drive-like UI (planned), a live Google Drive connection, or both.
- **Existing codebase or greenfield.** Determines whether the default stack applies.
- **Hosting.** If the web app sits on Netlify or Vercel, the workers still need a persistent host (Railway, Fly.io, Render or a container platform).
- **Outreach channels for agents.** Which channels agents may send through (email, Instagram DMs, X, TikTok) and each platform's automation rules; most social platforms restrict automated DMs.
- **Artist portal.** Whether signed artists get their own logins in a later phase.

Other risks to watch: YouTube quota growth (request an increase before many labels onboard), LLM cost spikes (enforce budgets from day one), and contract-term extraction accuracy (always show extracted terms for human confirmation, never auto-apply them).

## Sources

- Spotify Web API Changelog, February 2026
- Spotify Developer Terms, version 10
- YouTube Data API quota costs
- Deezer catalogue API fields and rate limit (third-party reference)
