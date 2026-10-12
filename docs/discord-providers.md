# Discord app: data providers

The plan's provider review (§7 scorecard, §9 compliance, §12 risks), done on 11 October 2026 from each provider's own terms and documentation. Terms change: check them again before relying on a source, and when a provider writes to you. This is not legal advice.

## Scorecard

| Provider | Coverage on cards | Access and cost | Terms for this use | Provenance |
|---|---|---|---|---|
| **MusicBrainz** | ISRC, UPC, release, date, label, ℗/© lines (as relationships), credits | No key. **1 request a second** per IP, with a User-Agent that names the app and a contact (the app sends `LabelConsole/0.1 ( <APP_URL> )`) | Core data is CC0 (public domain). Companies are asked to register as supporters: $0 tiers exist (non-commercial, non-profit, "Stealth Start-Up": not publicly offering a service); the paid tiers (from $100/month) describe public products. Or self-host a mirror from the free dumps | Record links on every card |
| **Deezer** | Search, ISRC, UPC, label, date, artwork, 30-second preview, availability | No key, no published rate limit (the app keeps to 50 per 5 s) | **Non-commercial, private use only**. Other uses need Deezer's approval. A visible Deezer logo is required. Preview audio must not be stored or made downloadable | Track and album links |
| **iTunes Search** | ℗ line, release date, by UPC | No key, about 20 calls a minute | Framed as promoting the store. Caching text metadata is encouraged. Previews (not used) must be streamed with a store badge | Album links |
| **Spotify Web API** (label's own key) | ISRC, UPC, ℗/© lines, markets; `label` is gone for new apps | Development mode only (extended access needs 250k monthly users): the owner needs Premium, 5 users | Bans products "targeted for use by businesses", storing content beyond temporary caching, and "compilations or databases". Content must be credited to Spotify and linked back | Track and album links |
| **SpotScraper** (label's key) | Spotify play counts, credits, label, ℗ line | $0.0005 a request | **No published terms.** It scrapes Spotify, which Spotify's user terms forbid: treat its data as unlicensed | Spotify links |
| **Discogs** (label's token) | Catalogue numbers, companies ("Distributed By"), credits, by UPC | 60 requests a minute with a token | Commercial use generally allowed. Data shown must be under 6 hours old and not kept longer than needed. Requires the notice below | "Data provided by Discogs." linked next to its data |
| **Apple Music API** (label's key) | ISRC, UPC, label | Developer membership | Only for giving users access to their Apple Music subscription: **not usable** for a catalogue lookup | — |
| **The label's own records** | Distributor, label, ℗/© lines, credits, plays | — | The label's own data | Verified on cards |

## What the app does about it

**Caching.** A lookup is cached for an hour per ISRC or UPC. That is inside Discogs' 6 hours and Spotify's "temporary caching".

**Evidence history.** The app keeps each source's value per field over time (the plan's `metadata_evidence`), for each source only as long as its terms allow. The limits are in `EVIDENCE_RETENTION_DAYS` in `modules/discord/service/index.ts`:

| Source | Kept | Why |
|---|---|---|
| MusicBrainz | 2 years | CC0 |
| iTunes | 30 days | Text caching encouraged |
| Spotify, SpotScraper, Deezer, Discogs, Apple, licensed vendors | Not kept | Their terms don't allow storing it, or it depends on the contract |

A source that isn't kept still shows on every card and in Extended Info. Only its history is missing.

**Previews.** The Audio File button links to Deezer's preview, which plays from Deezer. The app never downloads or attaches the audio. Preview links expire after about 15 minutes, so each press fetches a fresh one.

**Attribution.**
- Discogs: "Data provided by Discogs." with a link next to Discogs data on cards, credits and Extended Info. Its required statement appears in Settings → Discord and here: *This application uses Discogs' API but is not affiliated with, sponsored or endorsed by Discogs. 'Discogs' is a trademark of Zink Media, LLC.*
- Other sources: named in Extended Info, with links back to their records under Other Links.

**Rate limits.** Every source call shares one rate-limit bucket across all processes, so the app stays within each provider's limit.
- Replies give each source a time budget: 1.5 s to get a request slot, 8 s in all.
- A source that keeps failing is paused for two minutes by a circuit breaker.
- See [discord.md](discord.md) and the load test in [operations.md](operations.md).

**Scraped data.** SpotScraper stays an owner's decision (see [progress.md](progress.md), Open decisions). Its play counts are labelled as reported by SpotScraper, and daily readings are off unless an admin turns them on.

## Decisions for the owner

1. **Deezer.** Search, previews and much of the card come from Deezer, whose terms allow only non-commercial, private use. Choose one:
   - ask Deezer for approval (developers.deezer.com);
   - or accept the risk for an internal tool;
   - or move text search to MusicBrainz and iTunes, which is slower and finds less.
2. **MusicBrainz.** Register at [metabrainz.org](https://metabrainz.org/supporters/account-type) and describe the use. Their $0 tiers are:
   - Non-commercial / Personal;
   - Non-profit;
   - "Stealth Start-Up", for services not publicly offered.

   This app is a private tool for one label's staff, with a few hundred lookups a month, not offered to the public. Every paid tier describes a public product. MetaBrainz decides, so ask them. Running a mirror also avoids fees and removes the one-request-a-second limit, but needs a machine with a few hundred GB of disk.
3. **Spotify Web API.** The developer policy rules out business tools, and development mode no longer returns the label. Consider leaving it unconnected and relying on the other sources.
4. **Apple Music API.** Not permitted for this use. The iTunes Search API, which needs no key, covers the ℗ line and release date.

## Sources

- Spotify: [developer terms](https://developer.spotify.com/terms), [developer policy](https://developer.spotify.com/policy), [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes), [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- Discogs: [API documentation](https://www.discogs.com/developers), [API terms of use](https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use)
- Deezer: [terms of use](https://developers.deezer.com/termsofuse), [guidelines](https://developers.deezer.com/guidelines)
- MusicBrainz: [API](https://musicbrainz.org/doc/MusicBrainz_API), [rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting), [data licence](https://musicbrainz.org/doc/About/Data_License), [supporter tiers](https://metabrainz.org/supporters/account-type)
- Apple: [Search API](https://performance-partners.apple.com/search-api), [Developer Program License Agreement](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)
- SpotScraper: [spotscraper.com](https://www.spotscraper.com/)
