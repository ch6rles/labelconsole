# Discord app

A private Discord app for the label. Members link their Discord account to their Label Console login, then look things up from any server or DM. The cards follow DistroFind's layout:
- a small distributor card with the distributor's logo;
- the main card, with a field grid, cover art and buttons;
- each button opens its own reply.

## Commands

| Command | What it does |
|---|---|
| `/song query: [artist:] [share:]` | A song by Spotify, Apple Music, Deezer or YouTube link, ISRC, or "Artist - Title". |
| `/release query: [artist:] [share:]` | An album, EP or single by link, UPC/EAN or "Artist - Title". |
| `/artist query: [share:]` | Fans and releases (Deezer); country, type and start date (MusicBrainz); latest releases; writing credits on MusicBrainz; whether the artist is on your roster, and their credits in your catalogue (private cards only). |
| `/label query: [share:]` | MusicBrainz details (type, country, label code, founded, release count), your releases under that label, and the distributors on your records. |
| `/licensor query:` | What your own records verify about a distributor or licensor (see below). |
| `/compare first: second: [share:]` | Two songs or releases, field by field, with the differences first. For two songs, also the credits on one side only. |
| `/correct target: field: value: [note:]` | Suggest a correction for review. |
| `/link code:` and `/unlink` | Connect or disconnect your Discord account. |
| **Apps → Look Up Song** | On any message containing a song link, ISRC or UPC. |

**Replies are private by default.** They are visible only to the person who asked.
- `share:true` posts the card for everyone in the channel, if the label allows it.
- On a shared card, the buttons still answer each person privately, and only linked members get answers.
- Shared cards never show "In your catalogue" or the Label Console link.
- Admins choose under Settings → Discord → Sharing whether a shared card shows the distributor and the stream count.

**When a name matches several results,** the app asks "Which one?" with a list to pick from. This applies to songs, releases, artists and labels.
- It picks by itself only on a single exact match.
- Remixes and other versions are different songs.

## The card

**Distributor card:** the distributor's name, its logo (for known distributors) and how it is known:
- **Verified · in your distributor statements:** the release's UPC or ISRC appears in a statement from that distributor.
- **Verified · recorded in your catalogue:** a distributor someone entered, or confirmed at import.
- **Verified · reviewed correction**
- **Inferred · N% confidence, not proof:** from label text, ℗/© lines, learned UPC prefixes, and Discogs "Distributed By" credits.
- **Unknown**

**Main card:**

| Card | Fields |
|---|---|
| Song | 💿 Album, 🏷️ Label, 🔖 ISRC, 📅 Release Date, 🔢 UPC, 📈 Streams |
| Release | 🏷️ Label, 🔢 UPC, 📅 Release Date, 🎵 Tracks, 🗂️ Cat. No., ℗ P Line, © C Line |

- A value matching your catalogue (or a reviewed correction) is marked ✓.
- A value the sources disagree on is marked ⚠.
- The full story is behind **Extended Info**.
- Streams are Spotify's public play count from the lookup (needs SpotScraper), or the label's own latest reading.
- Spotify popularity is never shown as streams.

**Buttons:**

| Button | Opens |
|---|---|
| ℹ️ Extended Info | Includes:<ul><li>every field with its source and evidence;</li><li>identifiers on each platform;</li><li>⚠ where sources disagree;</li><li>the distributor's evidence and Discogs company credits;</li><li>reviewed corrections;</li><li>**History**: when it was checked, and values a source has changed over time;</li><li>how each source answered (✓, no match, timed out, busy, paused, not used).</li></ul> |
| 👥 View Credits | Grouped like Spotify's: Artist, Composition & Lyrics, Production & Engineering, Performers. From your catalogue for your songs. Otherwise from Spotify (through SpotScraper, one billed request), then MusicBrainz, then Discogs. |
| 📈 View Performance Chart | A chart image. Songs Label Console tracks show daily plays as bars; estimated days are lighter, and days with no reading are left empty. Any other song shows the count at each lookup as a line; a dashed line marks a long gap. |
| 🔗 Other Links | Exact links where known (Spotify, Apple Music, Deezer, MusicBrainz, Discogs), and clearly marked search links for YouTube Music, Tidal, Amazon Music and SoundCloud. |
| 🎧 Audio File | A link to Deezer's 30-second preview, played from Deezer, and to the song on Deezer. It is never attached: Deezer's terms forbid storing preview audio or making it downloadable. The link works for about 15 minutes. Never your masters. |
| 🌍 Playable Worldwide / Playable in N countries | Green when the song is available almost everywhere. The reply lists where it isn't available, from Spotify's markets or Deezer's countries. |
| ✏️ Report / Correct | A form: what is wrong, the correct value, and where that comes from. |
| 📃 View Tracklist | Releases only. |
| 📁 Open in Label Console | Your own songs only, on private cards. |

Splits, contract terms, statement money and internal notes never reach Discord.

Data from Discogs carries "Data provided by Discogs." linked to its page. Where each source's data may be used and kept is in [discord-providers.md](discord-providers.md).

## Corrections

`/correct` and the Report / Correct form file a suggestion. Nothing changes until someone with `catalogue:write` approves it.
- Members who can edit the catalogue get a notification and an item on the dashboard.
- They approve or reject under Settings → Discord.
- An approved value shows on cards as "✓ Verified · reviewed correction (name)". The sources' values stay in Extended Info.
- A newer approval for the same field replaces the older one.

## Sources and reliability

Each reply asks the sources in parallel and answers with what it has.

**Time budget.** A source gets 1.5 s to obtain a request slot under its rate limit, and 8 s in all. Past that, it is left out ("busy" or "timed out").
- MusicBrainz allows one request a second for the whole platform, so under a burst most cards answer without it.
- If a lookup finds nothing *because* sources were busy, it tries again with a long wait, so it is never reported as "not found". If that also fails, the reply says the databases are busy.

**Circuit breaker.** After 5 outages (timeouts, server errors, refusals) within 5 minutes, a source is paused for 2 minutes and cards answer from the others.
- One more failure right after the pause pauses it again.
- A success clears the count.
- Sources that use the label's own key (Spotify, SpotScraper, Apple, Discogs) are paused per label, so a bad key affects only that label.
- Errors retrying can't fix (a wrong key) don't count.
- Under Settings → Discord → Sources, an admin can see what is paused and try it again at once.

**Source health.** Settings → Discord → Sources shows, per source, over the last 7 days: calls, answered, no match, errors, timeouts, refusals, busy, paused, and median and 95th-percentile time.

## Evidence history

Each fresh lookup keeps what each source said, field by field, with when Label Console first and last saw that value and a link to the source's record.
- Recording fields (title, artists, duration, which UPC a source puts the song on) are kept under the ISRC.
- Release fields (label, ℗/© lines, date, catalogue number) are kept under each source's own UPC, so a re-release never mixes with the original.
- A new value is a new row: a label change or a re-delivery shows up in Extended Info → History as a change between two dates. Nothing between sightings is filled in.
- Corrections never touch it.

How long values are kept follows each provider's terms:
- MusicBrainz (CC0) for 2 years;
- iTunes for 30 days;
- Spotify, SpotScraper, Deezer, Discogs, Apple and licensed vendors not at all.

Details are in [discord-providers.md](discord-providers.md). The daily `discord.purge` job removes values past their time.

## Source benchmark

Settings → Discord → **Source benchmark** looks up 10, 20 or 50 random songs from your catalogue by ISRC, through every source, and checks each answer against your catalogue, where the right answer is known.
- It shows, per source and for the merged card, how often each field agreed (title, artist, duration, UPC, release date, label, ℗ and © lines).
- It also shows median time, and how often the inferred distributor matched distributors you confirmed.
- It lists the first disagreements.
- SpotScraper is left out unless ticked, since it is billed (about two requests a song).
- One benchmark runs at a time per label. It takes a few minutes, because of MusicBrainz's limit.
- Members limited to some artists see the scores without the per-song list.

Use it before relying on a source, and after connecting a new one.

## Daily readings

Songs outside your catalogue get a point on their chart each time someone looks them up.

With **Daily readings** (Settings → Discord, off by default), Label Console also reads the Spotify play count once a day for the songs looked up most recently in the last 30 days, up to the number set.
- Each song is one billed SpotScraper request a day.
- Songs in your catalogue are left out, because Streams tracks them.
- After three failures in a row it stops for the day.

## Set it up (once, as an owner or admin)

1. **Create the application.** In the [Discord Developer Portal](https://discord.com/developers/applications), create an application. You need three values from it:
   - the Application ID (General Information);
   - the Public Key (General Information);
   - a bot token (Bot → Reset Token).
2. **Connect it.** In Label Console, open Settings → Integrations → Discord app and paste the three values.
   - The application ID and public key are stored as plain settings, because the web app needs them to check each request.
   - The bot token is encrypted, and only the worker decrypts it.
3. **Set the Interactions Endpoint URL.** Copy the URL shown under Settings → Discord (`https://<your console>/api/discord/interactions`) into General Information → Interactions Endpoint URL, and save.
   - Discord checks the URL immediately, so do step 2 first.
   - The console must be on a public https address (`APP_URL`).
4. **Allow installs.** On the Installation page, tick:
   - **User Install**, so members can use the app in any server or DM;
   - optionally **Guild Install**, to add it to the label's server.

   Use the `applications.commands` scope for both.
5. **Register the commands.** Settings → Discord → Register commands. It registers only the install types switched on in step 4, so run it again after changing them, or after changing the bot token.
6. **Optional sources** (Settings → Integrations):
   - **SpotScraper:** stream counts and Spotify credits.
   - **Discogs** personal access token: catalogue numbers, company credits and credits by UPC.
   - **Spotify Web API:** markets and copyright lines.
   - **Apple Music:** Apple links and label data.

Discord has no way to stop someone installing the app from its link. Access is checked by Label Console on every request instead.

## Link an account (every member)

1. Settings → Discord → **Get a link code**.
2. In Discord, run `/link code:ABCD-EFGH` within ten minutes. The code works once.

What the link does:
- Your Discord account then acts as you, with your role in Label Console.
- Members whose access is limited to some artists only see the label's records for those artists.
- Removing someone from the label, or changing their role, applies to their next Discord request.
- Unlink with `/unlink`, or under Settings → Discord. Admins can remove anyone's link there.
- Unlinking also removes the person's name from the lookup log. The counts stay, for the label's metrics.

## Monitoring and runbook

Settings → Discord → **Last 7 days** shows, for the launch checks in the plan:
- commands, and the share answered with a card;
- how often it asked "Which one?";
- nothing found, and errors;
- how many ISRC/UPC lookups resolved;
- cache hits;
- median and 95th-percentile time;
- how many fresh lookups were missing a source;
- corrections suggested, against cards shown;
- for each field (ISRC, UPC, label, ℗, ©, distributor, credits, streams), the share verified, source-reported, conflicting, inferred and unknown.

**Sources** below it has the per-source health.

`/api/metrics` also exports these for the last 24 hours, across labels:
- `lc_discord_links`
- `lc_discord_lookups_24h{outcome}`
- `lc_discord_lookup_ms_24h{quantile}`
- `lc_discord_cache_hits_24h`
- `lc_metadata_source_calls_24h{source,outcome}`
- `lc_metadata_source_ms_24h{source,quantile}`
- `lc_metadata_source_paused{source}`
- `lc_jobs_total{job="discord.interaction"}`

Alerts in `infra/prometheus/alerts.yml`, with panels in the Grafana dashboard's "Discord app" row:
- `DiscordLookupErrors`: over 10% of commands failed in a day.
- `DiscordLookupsSlow`: 95th percentile over 15 s.
- `MetadataSourceFailing`: a source failed over half its calls in a day.
- `MetadataSourcePaused`: a source has been paused for 30 minutes.

| Symptom | Check |
|---|---|
| Discord says "The application did not respond" | The web app must answer within 3 seconds. Check `/api/health?deep=1` (database and Redis). The endpoint gives Redis 1.5 s and then answers "busy". |
| Replies stay on "thinking…" | The worker isn't running, or the job failed. Check `lc_jobs_total{job="discord.interaction",result="failed"}` and the worker log ("discord lookup failed"). Interaction tokens expire after 15 minutes. |
| "Discord didn't accept the reply" | Discord rejected the edit (for example a malformed field). The worker log has the HTTP status and body. |
| Interactions URL removed by Discord | The public key in Settings → Integrations must match the portal's Public Key. |
| Commands missing | Settings → Discord → Register again. The last error is shown there. |
| A source shows as paused, or `MetadataSourcePaused` fires | Settings → Discord → Sources. Check the provider's status page, and the key under Settings → Integrations for Spotify, SpotScraper, Apple or Discogs. **Try now** clears the pause. |
| Many "busy, skipped" for MusicBrainz | Expected under bursts: it allows one request a second for the whole platform. For heavier use, run a MusicBrainz mirror or take its paid tier ([discord-providers.md](discord-providers.md)). |
| A reply says the music databases are busy | Every source was busy or failing, even on the second, slower try. Check Sources and `lc_metadata_source_calls_24h`. |
| Chart replies without an image | The worker image needs `sharp` and a font (`fonts-dejavu-core`, installed by the Dockerfile). Without them the reply still has the numbers. |

Housekeeping: a daily job (`discord.purge`) drops:
- lookup logs older than six months;
- used or expired link codes;
- evidence past its retention;
- benchmarks older than a year.

## Who can do what

| Action | Needs |
|---|---|
| Link an account, use the commands and buttons | `catalogue:read` (checked on every request, with the member's artist scope) |
| See the label's own records on a card (catalogue, credits, statements) | The member's own permissions: `catalogue:read`, `streams:read`, `people:read` |
| Suggest a correction | `catalogue:read` |
| Approve or reject a correction | `catalogue:write` |
| See setup, links, stats, sources and benchmarks | `settings:read` |
| Change sharing or daily readings, register commands, run a benchmark, resume a source | `settings:manage` |
| Remove someone else's link | `settings:members` |
| Connect the app, the bot token, Discogs or SpotScraper | Settings → Integrations (owner or admin) |

Every change above is in the audit log.

## Launch checklist

The plan's exit criteria for production (phase 7):

1. **Set up and registered.** Settings → Discord shows steps 1–4 done. `/song` answers in a DM and in a server.
2. **Linked members only.** Someone without a link gets "Link your Discord account first". Removing a member stops their link at once.
3. **Benchmark run.** Settings → Discord → Source benchmark on 20–50 songs. Sources that disagree with your catalogue often are noted, or left unconnected.
4. **Provider decisions made.** The four decisions in [discord-providers.md](discord-providers.md) (Deezer, MusicBrainz, Spotify, Apple).
5. **Monitoring on.** Prometheus scrapes `/api/metrics`, the alert rules are loaded, and the dashboard is imported.
6. **Backups.** `pnpm db:restore-drill` passes (the Discord tables are per label, with row-level security, so the drill covers them).
7. **Load.** `pnpm test:load` passes. The numbers are in [operations.md](operations.md).
8. **Sharing reviewed.** An admin has chosen what shared cards may show (Settings → Discord → Sharing).

## How it works

| Piece | Where |
|---|---|
| Endpoint | `apps/web/src/app/api/discord/interactions/route.ts` → `modules/discord/interactions.ts` |
| Worker | `discord.interaction` job → `modules/discord/lookup.ts`; `discord.benchmark` → `benchmark.ts`; `discord.readings` → `readings.ts` |
| Rendering | `modules/discord/cards/` (pure), the chart in `modules/discord/chart.ts` |
| Links, codes, corrections, sharing, metrics | `modules/discord/service/index.ts` |
| Artist and label sources | `modules/discord/sources.ts` (Deezer, MusicBrainz) |
| Song sources and credits | the catalogue's resolver, plus `modules/catalogue/metadata/sources/discogs.ts` and `credits.ts` |
| Circuit breaker, time budgets | `modules/catalogue/metadata/breaker.ts`, `withBudget` in `packages/core/src/http.ts` |
| Tables (all per label, with row-level security) | `discord_links`, `discord_link_codes`, `discord_state`, `discord_corrections`, `discord_play_readings`, `discord_lookups`, `discord_evidence`, `discord_benchmarks` |

**The endpoint** does this, in order:
1. Verifies Discord's Ed25519 signature against the public key of the application the request names.
2. Refuses requests older than five minutes.
3. Checks the member's link and current access.
4. Rate-limits each person.
5. Queues the work and answers within Discord's 3 seconds.
   - Commands and buttons get a "thinking…" reply; picks replace the list.
   - Report / Correct opens its form at once.

**The worker job:**
1. Checks access again.
2. Resolves the song, reading the label's provider keys as the system.
3. Reads the label's own records *as the member*.
4. Edits the reply, uploading the chart image when there is one.
5. Keeps the evidence each source allows, and logs the lookup with how each source answered.

Lookups are cached for an hour per ISRC or UPC, so the buttons are fast and don't ask every source again. Each fresh Spotify play count is also kept as a reading, at most one an hour per song, for the chart.

**Tests:**
- `modules/discord/discord.test.ts`: signatures, codes, commands, ids, cards and views, the form, the chart.
- `modules/discord/discord.int.test.ts`: signed requests end to end for every command, button and form, sharing, corrections, statements, access changes, rate limits, metrics, the evidence history, a paused source, the benchmark, daily readings and command registration.
- `modules/catalogue/metadata/credits.test.ts`: Discogs and the credits fallbacks.
- `modules/discord/acceptance.test.ts`: the plan's acceptance criteria (§11), one test per row, plus the circuit breaker, evidence retention, attribution, previews, metrics and benchmark scoring.
- `packages/core/src/http.test.ts`: time budgets.
- `test/load/discord.load.test.ts` (`pnpm test:load`): many members across labels at once, through the real endpoint, queue and worker.
