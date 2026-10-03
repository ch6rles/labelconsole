# Label Console — build progress

> **Current position:** All seven phases are done. What's left are decisions only the owner can make (see **Open decisions**), plus the follow-ups listed under **Next steps**.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: pnpm monorepo, core platform (tenancy + RLS, auth/sessions, permissions, vault, audit, outbox events, BullMQ queues, worker service, SSE realtime, storage), design system, console shell | Done |
| 2 | Catalogue + in-house metadata lookup (`POST /v1/metadata/resolve`, distributor inference, bulk import, demos + public intake) | Done |
| 3 | People, Drive, Documents (contracts with AI term review, statements, royalties, key dates) | Done |
| 4 | Streams (YouTube Data API adapter, Spotify play counts via SpotScraper, statement-import adapter, licensed-provider interface, snapshots, rollups, alerts) | Done |
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
  - **Hybrid recall:** relevance × 6 + full-text rank × 4 + importance + recency. Relevance is cosine similarity above a 0.2 noise floor, scaled by 0.5. Calibrated on real Voyage scores: unrelated texts land around 0.15–0.3 and related ones 0.4–0.75. So a clearly relevant memory outranks an unrelated one of any importance.
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

## SpotScraper (Spotify data)

The owner chose [SpotScraper](https://spotscraper.readme.io) for Spotify data. Built from its API reference and checked against live responses (where they differ from the reference, the client accepts both). The client is `packages/core/src/spotscraper.ts`: an `x-api-key` header, a shared Redis rate limit, and normalised types. Raw responses never leave that file. Podcast, audiobook and user endpoints exist but aren't wrapped; a label has no use for them.

- **Key:** the label's own (Settings → Integrations → SpotScraper), else the platform `SPOTSCRAPER_API_KEY`. SpotScraper bills per request ($0.0005 at the time of writing). Every request is counted in the label's `spotscraper_requests` usage counter.
- **Spotify play counts (Streams):** a new polled source, `spotscraper`, with platform `spotify`.
  - **Matching:** each track is matched by ISRC search, preferring the release by the track's own artist, then the most popular. An exact ISRC match needs no review. A Spotify ID the catalogue already knows is reused without a request. Unmatched ISRCs are searched again weekly.
  - **Polling:** one request per track per poll, at the usual cadence (every 6 hours for active tracks, daily for catalogue).
  - **One ID per track:** a track is polled through exactly one Spotify ID (identity variant `primary`). Re-releases share the ISRC and Spotify's merged count, so polling several would double count.
  - **Staff links:** staff can paste the right Spotify link. The rollup for single-ID sources reads one ID at a time, so switching IDs continues the series without doubling the total or showing a fake spike.
  - **No YouTube needed:** tracks with only a Spotify ID are tracked.
- **First readings:** the first day of any series has a running total but no plays figure. The track page, charts and agents show it as such rather than as 0. Movers flag `newlyTracked` so a track's first readings aren't presented as a gain.
- **Artist audience (People and Streams):** a daily job reads monthly listeners, followers, world rank, top cities and "discovered on" playlists for every artist with a Spotify artist ID. It costs two requests per artist, and results are stored in `artist_spotify_stats` (migration `0003`). Artist pages show a Spotify audience panel with 28-day changes.
- **Credits (Catalogue):** "From Spotify" on a track, or "Credits from Spotify" on the tracks list (for every track without credits).
  - Credits are added without duplicates.
  - Roster artists are linked by name or alias.
  - The "No credits" delivery blocker clears.
- **Metadata lookup:** SpotScraper is a lookup source, ranked just below the Spotify Web API.
  - By ISRC: the track, then its album for UPC, label, release date, ℗ line and tracklist.
  - By Spotify link: works without Spotify Web API credentials.
- **Playlists (Network):** follower counts for Spotify playlists are refreshed weekly, when a playlist is added, or on demand. Adding a playlist by link fills in its ID.
- **Agents:** they only ever see derived numbers.
  - `streams_get_history` reports the `spotscraper` source.
  - `streams_artist_audience` (by artist or track) gives audience numbers and discovered-on playlists. Listener account names are dropped.
  - `streams_spotify_artist_lookup` checks any artist's audience by profile link; A&R Scout uses it for demos.
- **Verified live** against the real API: ISRC match, play count, 7 credits, artist audience, playlist followers, and a real agent run answering from the stored numbers.
- **Tests:** 144 passing. They cover client parsing against recorded live responses, matching, single-ID rollups, the missing-key path, audience, credits, playlists and the metadata source.

## Single-label installation (River Of Styxx)

The owner runs this installation for one label only, so there is no public sign-up.

- **First run:** on a fresh install, the first visit goes to `/setup`, which creates the label (`LABEL_NAME`, default "River Of Styxx") and its owner account. Setup then closes for good.
  - A transaction-level lock makes two simultaneous attempts safe: the second is refused.
  - `/setup` redirects to sign-in, and `POST /api/auth/setup` answers 409.
- **Team access:** others join by invitation (Admin → Users). "New label" is gone from the label menu, and the menu only opens for someone in more than one label.
- **Removed:** the sign-up page and the sign-up and create-label endpoints. Unknown `/api` paths now return a JSON 404 instead of falling through to the console's sign-in redirect.
- **Owner command:** `pnpm owner --email …` (Docker: `node dist/owner.js`) makes sure the label exists and that this person owns it, with a password typed without echo.
  - It doubles as password recovery, since there is no reset email.
  - A new password signs out the user's older sessions.
- **Docker:** compose now passes `LABEL_NAME` and the Voyage, SpotScraper and Anthropic workspace settings through to the containers.
- **Verified** in a browser on an empty database: setup to the River Of Styxx dashboard, setup closed for a second visitor, removed endpoints returning 404, and both owner command paths (`tsx` and the bundled worker).
- **Tests:** 146 passing (setup race and closure, owner add and password reset).

## Railway deployment

Netlify can't host Label Console: it needs an always-on worker, Postgres and Redis next to the website, and Netlify functions stop after 10 seconds. The owner chose Railway. The setup steps are in [deploy-railway.md](deploy-railway.md).

- **One Dockerfile for both services.** Railway can't select a build stage, so the last stage (`app`) holds both apps and starts the worker when `LC_TARGET=worker` is set at runtime, otherwise the web app. A runtime variable can't be lost the way a build argument can. There are no BuildKit cache or secret mounts, because Railway rejects cache mounts without its own per-service ids. A proxy CA certificate can still be passed as `NPM_CA` for local builds. Compose keeps using `target:`.
- **One database URL.**
  - With only `DATABASE_SUPERUSER_URL` (Railway's admin connection string) and `SIGNING_SECRET`, the app derives the restricted app-role and owner-role URLs: same server, database `labelconsole`, passwords derived from `SIGNING_SECRET`.
  - `setup` creates the roles, the database and the extensions with those values, and re-syncs the passwords on every run.
- **Release on start.** When the database URLs are derived, or `LC_RELEASE_ON_START=1` is set, the web app (`instrumentation.ts`) and the worker both run setup and migrations as they start. A Postgres advisory lock makes them take turns, and both steps are idempotent. The first deploy therefore works whichever service starts first, even if the worker's settings are wrong.
- **Health check that explains itself.** `/api/health` reports the innermost database error (drizzle wraps it as "Failed query") and which connection was used, without the password. With `?deep=1` it also checks the worker heartbeat whenever Redis is up.
- **Railway buckets.** `S3_FORCE_PATH_STYLE=false` selects virtual-hosted bucket URLs.
- **Redis.** Connections look up IPv4 and IPv6 (`family: 0`), since Railway's older private networks are IPv6-only.
- **Rehearsed locally with Docker**, using the guide's variables against pgvector Postgres 17, Redis and an S3 server with virtual-hosted buckets:
  - Both images build the way Railway builds them.
  - The worker created the roles and the database, migrated, and started.
  - The website's deep health check passed, and the first visit went to setup and then to the River Of Styxx dashboard.
  - A file uploaded, and its signed download link (virtual-hosted) returned it.
  - A worker restart re-ran the release cleanly, and the owner command worked inside the worker container.

## Social research (Apify) and custom agents

The owner asked for an agent that researches editors and creators on TikTok, Instagram and YouTube like a person would, limited to chosen platforms when asked, and that can save images to Drive. The owner chose Apify; the scrapers are called from the app's own agent tools rather than through Apify's MCP server, which is meant for chat clients.

- **Apify client** (`packages/core/src/apify.ts`): one synchronous call per scrape (`run-sync-get-dataset-items`), never retried automatically because every result is billed. A run refused for the plan's concurrent-run limit waits and retries. Token problems, lack of credit and unknown Actors get plain messages.
  - **Token:** the label's own (Settings → Integrations → Apify), else the platform `APIFY_API_TOKEN`. Results are counted in the label's `apify_results` usage counter.
  - **Actors:** `clockworks/tiktok-scraper`, `apify/instagram-scraper` and `streamers/youtube-scraper`. Their inputs and outputs were checked against live runs.
- **Normalised data** (`modules/network/social/`): every platform becomes the same creator and post shape. Hidden counts (Instagram's −1 likes, YouTube's 0 likes on a watched video) become "unknown" rather than numbers.
- **Analysis**, the checks a buyer makes before paying for a promo:
  - **Activity:** days since the last post, and posts per week.
  - **Reach:** median and average views, engagement, and views versus followers. The last one exposes bought or dead followers.
  - **Momentum:** whether recent posts are rising or cooling compared with earlier ones. Posts younger than two days are still collecting views, so they are left out of the trend; one that already beats the usual is flagged as trending now. Pinned posts are ignored.
  - **Other:** breakout hits, paid partnerships, and cost per 1,000 views when a price is given.
  - **Signals:** each finding is also written as a plain sentence.
- **Six agent tools** in the network module:
  - `social_tiktok_search` (creators, videos with period and sort, or a hashtag) and `social_tiktok_profile`.
  - `social_instagram_search` (a hashtag's recent posters, or accounts) and `social_instagram_profile`.
  - `social_youtube_search` (sort and upload date) and `social_youtube_profile` (videos and Shorts).
  - The profile tools take up to five accounts per call.
  - Creators already in the network are marked, including do-not-contact.
  - Image links are included only when asked for (`includeImages`).
- **Platform limits:** tools declare a `platform`. "Run now" shows a Platforms choice for agents with tools for more than one platform. A run started for some platforms only gets those platforms' tools, and the agent is told to keep web research there too. Webhook payloads can't set platforms.
- **`drive_save_images`:** saves up to 20 images from public links into a folder path such as "Research/Funk editors", creating missing folders.
  - **Downloads** go through `fetchPublicFile` (`packages/core/src/net.ts`):
    - https only;
    - every resolved address is checked at connect time, so DNS rebinding can't reach internal hosts;
    - redirects are re-checked;
    - image types only, under 15 MB, with a timeout.
  - **Safety checks:** files then go through the usual upload checks (type sniffing, size, plan storage, virus scan).
  - **Moved code:** the stream webhook's URL check moved into the same file.
- **New agent types:**
  - **Social Scout:** searches, shortlists, profiles, and gives each creator a "buy now", "watch" or "skip" verdict with the deciding numbers. It adds strong finds to the network and saves images when asked.
  - **Custom Agent:** a blank agent. Staff write its goal and instructions, tick its tools, and give each run a task.
  - **Existing types:** Creator Outreach, Trend & Social Monitor and A&R Scout get the social tools too. Agents created before this keep their tool lists; tick the new tools in their configuration.
- **Readable results:** an agent's final answer is shown as formatted text (headings, tables, lists, bold, links) on the run page and in its activity. The renderer (`packages/ui/src/markdown.tsx`) builds React elements and never raw HTML, and only allows web, mail and in-console links. Lists of agents and runs show a one-line plain preview.
- **Agent indicator:** the top bar's "running" count no longer sticks after a run ends. It used to count events up and down, so a run already going when the page loaded never counted down. It now re-reads the real numbers (`GET /agent-activity`) after any run or approval event, after a reconnect, and every minute while something runs.
- **Bug fixed along the way:** cutting text with `slice()` could split an emoji. Half an emoji is invalid Unicode, which Postgres refuses in json columns, so the whole step failed. `clip()` now does this safely in tool results and runtime truncation.
- **Verified live:**
  - Every scraper was run against Apify, and an image was downloaded from TikTok's CDN.
  - A real Social Scout run (Claude and Apify, TikTok only) was offered only TikTok's tools. It searched, profiled two editors, gave verdicts with the numbers, and saved a profile picture to Drive.
  - The run cost $0.16 of model usage and 21 Apify results.
- **Tests:** 179 passing.
  - **Parsers and analysis:** checked against recorded live results, with small accounts renamed.
  - **Apify client:** request shape, concurrency retry, and error messages.
  - **Downloader safety:** the address checks above.
  - **Tools:** with a fake Apify.
  - **Full Social Scout run:** a scripted model with the TikTok-only limit and images saved to Drive.
  - **Custom agent creation.**

## Spotify sync and Spotify tools for agents

The owner asked to show monthly listeners and live stream counts, to bring an artist's songs into the catalogue without adding them by hand, to download their audio automatically, and to give agents Spotify tools. SpotScraper already supplied play counts and audiences, so it does the lookups. Apify adds keyword search, which SpotScraper lacks.

- **Sync from Spotify:** a button in the Releases panel on an artist page, or the `catalogue_sync_spotify_artist` agent tool.
  - **How it runs:** in the background, the worker reads the artist's discography (SpotScraper), skips releases already linked to Spotify, and imports the rest through the bulk-import pipeline. UPC, label, date, ℗ line and tracklist come from Spotify; ISRCs come from Deezer by UPC; records are created automatically.
  - **Disagreements between sources:** small ones (a label spelling, a date a day apart) don't stop it. A clash over the UPC or ISRC sends the release to review.
  - **Label releases only:** the option keeps releases that name the label in their label field or ℗/© line, and leaves out earlier releases on other labels.
  - **Artist matching:** the artist's Spotify name is added as an alias, so credits land on the roster artist instead of creating a duplicate.
  - **Play counts:** every imported track gets its Spotify track ID as the one Streams polls, unless it already has one. Plays start updating without an ISRC search, even for tracks without an ISRC.
  - **Progress:** the artist page shows the last sync's result, and the Import page lists syncs next to CSV imports.
  - **Schema:** migration `0004` adds `catalogue_imports.meta` to record which artist a sync belongs to.
- **Audio is not downloaded.** Spotify streams are DRM-protected, and ripping them breaks Spotify's terms. The result would also be a lossy copy dressed up as a WAV, not a master fit for distribution. Masters still come from the label: upload each one on its track page.
- **Numbers in lists:**
  - **Monthly listeners:** shown on the roster list and the artist page. They are read as soon as an artist's Spotify link is added or changed, instead of at the next daily run.
  - **Spotify plays:** the track list and release tracklists show all-time plays and the last 7 days' gain.
- **Agent tools:**
  - `spotify_search`: playlists, artists, tracks or albums by keyword, via the Apify Actor `automation-lab/spotify-scraper`, filled in with followers, monthly listeners, play counts or label from SpotScraper.
  - `spotify_track_lookup`: by link or ISRC.
  - `spotify_album_lookup`
  - `spotify_playlist_lookup`: curator, followers and tracks with when each was added. `labelTracks` lists the label's songs already on the playlist.
  - `spotify_artist_discography`
  - `catalogue_sync_spotify_artist`
  - **Catalogue matches:** results say which items are already in the catalogue.
  - **Given to:** Playlist & Editor Outreach, A&R Scout, Trend Monitor, Social Scout, Creator Outreach and the Custom Agent.
- **Verified live:**
  - A real artist synced in 5 seconds: 4 releases and 11 tracks, with Deezer ISRCs and Spotify IDs.
  - The first poll read their real play counts, and their monthly listeners were read straight away.
  - `spotify_search` returned real playlists with follower counts, and `spotify_playlist_lookup` read a 141-track playlist.
- **Tests:** 189 passing.
  - **Client parsing:** discography and playlist tracks, against recorded live responses.
  - **Sync:** new releases imported with ISRCs and primary Spotify IDs, known releases skipped, other labels' releases left out, alias added, no second sync while one runs, the error paths.
  - **Lists:** monthly listeners and 7-day plays.
  - **Agent tools:** every one, with fake clients.

## Next steps

1. Decide the open items below; each has its integration point ready.
2. Run the restore drill and the load test against staging infrastructure, and record the numbers in `docs/operations.md`.
3. Set real plan limits in `packages/core/src/plans.ts` once pricing is decided.

## Open decisions

These need the owner. Nothing paid was added without asking.

- **API keys:** Anthropic, Voyage AI, SpotScraper and Apify are set and verified live. A YouTube Data API key is still needed for YouTube views.
- **Spotify data source:** SpotScraper was chosen by the owner. It most likely works by scraping Spotify, which the original spec ruled out; that trade-off is the owner's call. A licensed vendor can still be added later through `modules/streams/sources/licensed.ts`.
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
