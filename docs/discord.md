# Discord app

A private Discord app for the label. Members link their Discord account to their Label Console login, then look up songs and releases from any server or DM:

- `/song query:<link, ISRC, UPC or "Artist - Title"> [artist:<name>]`
- **Apps → Look Up Song** on a message that contains a song link, ISRC or UPC
- `/link code:<code>` and `/unlink`

Replies are only visible to the person who asked. Anyone who isn't a linked member of the label gets a short "link your account first" reply and nothing else.

## Set it up (once, as an owner or admin)

1. **Create the application.** In the [Discord Developer Portal](https://discord.com/developers/applications), create an application. You need three values from it:
   - the Application ID (General Information);
   - the Public Key (General Information);
   - a bot token (Bot → Reset Token).
2. **Connect it.** In Label Console, open Settings → Integrations → Discord app and paste the three values.
   - The application ID and public key are stored as plain settings, because the web app needs them to check each request.
   - The bot token is encrypted, and only the worker decrypts it, to register the commands.
3. **Set the Interactions Endpoint URL.** Copy the URL shown under Settings → Discord (`https://<your console>/api/discord/interactions`) into General Information → Interactions Endpoint URL, and save. Discord checks the URL immediately, so do step 2 first. The console must be on a public https address (`APP_URL`).
4. **Allow installs.** On the Installation page, tick:
   - **User Install**, so members can use the app in any server or DM;
   - optionally **Guild Install**, to add it to the label's own server.

   Use the `applications.commands` scope for both. Settings → Discord shows the install links.
5. **Register the commands.** Settings → Discord → Register commands. It registers only the install types switched on in step 4, so run it again after changing them, or after changing the bot token.

Discord has no way to stop someone installing the app from its link. Access is checked by Label Console on every request instead.

## Link an account (every member)

1. Settings → Discord → **Get a link code**.
2. In Discord, run `/link code:ABCD-EFGH` within ten minutes. The code works once.

What the link does:
- Your Discord account then acts as you, with your role in Label Console.
- Members whose access is limited to some artists only see the label's records for those artists.
- Removing someone from the label, or changing their role, applies to their next Discord request.
- Unlink with `/unlink`, or under Settings → Discord. Admins can remove anyone's link there.

## What a lookup shows

The lookup is the same one as Catalogue → Track Import: Deezer, MusicBrainz, iTunes, plus Spotify, SpotScraper, Apple Music and a licensed provider when they are connected. Nothing is saved to the catalogue.

| View | Contents |
|---|---|
| Overview | Title, artists, release, ISRC, UPC, label, ℗ and © lines, distributor, cover art, and whether the song is in your catalogue |
| Extended info | Every field with where it came from, where sources disagree, platform IDs, and which sources answered |
| Credits | Credits from your catalogue (songs in it only) |
| Tracklist | For releases |
| Other links | Spotify, Apple Music, Deezer, YouTube and MusicBrainz |
| Performance | Play counts Label Console tracks for your own songs, with the date of the reading. Needs Streams and the `streams:read` permission |

Each field carries an evidence label:

- **Verified:** it matches the label's own record.
- **Reported by …:** names the sources that gave this value.
- **Sources disagree:** see Extended info.
- **Inferred:** distributor guesses, with their confidence. Never presented as fact.
- **Unknown:** no source gave a value.

Splits, contract terms, statements, money and internal notes are never sent to Discord.

**When a title matches several songs**, the app asks "Which one?" with a list to pick from. It only picks by itself when exactly one result matches the title exactly, and either you gave the artist or it is the only result. Remixes and other versions count as different songs.

## How it works

| Piece | Where |
|---|---|
| Endpoint | `apps/web/src/app/api/discord/interactions/route.ts` → `modules/discord/interactions.ts` |
| Worker | `discord.interaction` job → `modules/discord/lookup.ts` |
| Card rendering | `modules/discord/render.ts`, pure functions |
| Links and codes | `modules/discord/service/index.ts` |
| Tables | `discord_links`, `discord_link_codes`, `discord_state` (all per label, with row-level security) |

**The endpoint** does this, in order:
1. Verifies Discord's Ed25519 signature against the public key of the application the request names.
2. Refuses requests older than five minutes.
3. Checks the member's link and current access.
4. Rate-limits each person.
5. Queues the work and answers within Discord's 3 seconds with a private "thinking…" reply.

**The worker job:**
1. Checks access again.
2. Resolves the song, reading the label's provider keys as the system.
3. Reads the label's own records *as the member*.
4. Edits the reply.

Lookups are cached for an hour per ISRC or UPC, so switching views is instant.

Interaction tokens last 15 minutes. They sit in the queue only until the job finishes, under a key the logs redact.

**Tests:**
- `modules/discord/discord.test.ts`: signatures, link codes, commands, rendering, evidence labels, the "Which one?" list, message parsing.
- `modules/discord/discord.int.test.ts`: signed requests end to end, linking, lookups, access changes, rate limits, the module switch, command registration.
