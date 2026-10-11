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
| `/artist query: [share:]` | Fans and releases (Deezer); country, type and start date (MusicBrainz); latest releases; whether the artist is on your roster. |
| `/label query: [share:]` | MusicBrainz details (type, country, label code, founded, release count), your releases under that label, and the distributors on your records. |
| `/licensor query:` | What your own records verify about a distributor or licensor (see below). |
| `/compare first: second: [share:]` | Two songs or releases, field by field, with the differences first. |
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
| ℹ️ Extended Info | Every field with its source and evidence; identifiers on each platform; ⚠ where sources disagree; the distributor's evidence and Discogs company credits; reviewed corrections; which sources answered. |
| 👥 View Credits | Grouped like Spotify's: Artist, Composition & Lyrics, Production & Engineering, Performers. From your catalogue for your songs. Otherwise from Spotify (through SpotScraper, one billed request), then MusicBrainz, then Discogs. |
| 📈 View Performance Chart | A chart image. Songs Label Console tracks show daily plays as bars; estimated days are lighter, and days with no reading are left empty. Any other song shows the count at each lookup as a line; a dashed line marks a long gap. |
| 🔗 Other Links | Exact links where known (Spotify, Apple Music, Deezer, MusicBrainz, Discogs), and clearly marked search links for YouTube Music, Tidal, Amazon Music and SoundCloud. |
| 🎧 Audio File | Deezer's 30-second preview as an audio attachment. Never your masters. |
| 🌍 Playable Worldwide / Playable in N countries | Green when the song is available almost everywhere. The reply lists where it isn't available, from Spotify's markets or Deezer's countries. |
| ✏️ Report / Correct | A form: what is wrong, the correct value, and where that comes from. |
| 📃 View Tracklist | Releases only. |
| 📁 Open in Label Console | Your own songs only, on private cards. |

Splits, contract terms, statement money and internal notes never reach Discord.

## Corrections

`/correct` and the Report / Correct form file a suggestion. Nothing changes until someone with `catalogue:write` approves it.
- Members who can edit the catalogue get a notification and an item on the dashboard.
- They approve or reject under Settings → Discord.
- An approved value shows on cards as "✓ Verified · reviewed correction (name)". The sources' values stay in Extended Info.
- A newer approval for the same field replaces the older one.

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

## Monitoring and runbook

Settings → Discord → **Last 7 days** shows, for the launch checks in the plan:
- commands, and the share answered with a card;
- how often it asked "Which one?";
- nothing found, and errors;
- how many ISRC/UPC lookups resolved;
- cache hits;
- median and 95th-percentile time;
- field coverage: label, ℗, ©, distributor, credits and streams, known and verified.

`/api/metrics` also exports these for the last 24 hours, across labels:
- `lc_discord_links`
- `lc_discord_lookups_24h{outcome}`
- `lc_discord_lookup_ms_24h{quantile}`
- `lc_discord_cache_hits_24h`
- `lc_jobs_total{job="discord.interaction"}`

| Symptom | Check |
|---|---|
| Discord says "The application did not respond" | The web app must answer within 3 seconds. Check `/api/health?deep=1` (database and Redis). The endpoint gives Redis 1.5 s and then answers "busy". |
| Replies stay on "thinking…" | The worker isn't running, or the job failed. Check `lc_jobs_total{job="discord.interaction",result="failed"}` and the worker log ("discord lookup failed"). Interaction tokens expire after 15 minutes. |
| "Discord didn't accept the reply" | Discord rejected the edit (for example a malformed field). The worker log has the HTTP status and body. |
| Interactions URL removed by Discord | The public key in Settings → Integrations must match the portal's Public Key. |
| Commands missing | Settings → Discord → Register again. The last error is shown there. |
| Chart replies without an image | The worker image needs `sharp` and a font (`fonts-dejavu-core`, installed by the Dockerfile). Without them the reply still has the numbers. |

Housekeeping: a daily job (`discord.purge`) drops lookup logs older than six months, and used or expired link codes.

## How it works

| Piece | Where |
|---|---|
| Endpoint | `apps/web/src/app/api/discord/interactions/route.ts` → `modules/discord/interactions.ts` |
| Worker | `discord.interaction` job → `modules/discord/lookup.ts` |
| Rendering | `modules/discord/cards/` (pure), the chart in `modules/discord/chart.ts` |
| Links, codes, corrections, sharing, metrics | `modules/discord/service/index.ts` |
| Artist and label sources | `modules/discord/sources.ts` (Deezer, MusicBrainz) |
| Song sources and credits | the catalogue's resolver, plus `modules/catalogue/metadata/sources/discogs.ts` and `credits.ts` |
| Tables (all per label, with row-level security) | `discord_links`, `discord_link_codes`, `discord_state`, `discord_corrections`, `discord_play_readings`, `discord_lookups` |

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
4. Edits the reply, uploading the chart image or preview when there is one.
5. Logs the lookup.

Lookups are cached for an hour per ISRC or UPC, so the buttons are fast and don't ask every source again. Each fresh Spotify play count is also kept as a reading, at most one an hour per song, for the chart.

**Tests:**
- `modules/discord/discord.test.ts`: signatures, codes, commands, ids, cards and views, the form, the chart.
- `modules/discord/discord.int.test.ts`: signed requests end to end for every command, button and form, sharing, corrections, statements, access changes, rate limits, metrics and command registration.
- `modules/catalogue/metadata/credits.test.ts`: Discogs and the credits fallbacks.
