export {};

/**
 * What a deferred interaction asks the worker to do. `shared` marks a card
 * posted for everyone in the channel (the label's sharing settings apply).
 */
export type DiscordAction =
  /** /song, /release or "Look Up Song": a link, ISRC, UPC or text. */
  | { kind: 'lookup'; input: string; artist?: string | null; entity?: 'track' | 'release'; shared?: boolean }
  /** A choice from the "Which one?" list: `dz:<id>`, `dza:<album id>` or `isrc:<ISRC>`. */
  | { kind: 'pick'; key: string; shared?: boolean }
  /** A button on a card: open another view of the same track or release as a private reply. */
  | { kind: 'view'; view: string; ref: string }
  | { kind: 'artist'; input: string; shared?: boolean }
  | { kind: 'pickArtist'; key: string; shared?: boolean }
  | { kind: 'label'; input: string; shared?: boolean }
  | { kind: 'pickLabel'; key: string; shared?: boolean }
  | { kind: 'licensor'; input: string }
  | { kind: 'compare'; first: string; second: string; shared?: boolean }
  | { kind: 'correct'; input: string; field: string; value: string; note?: string | null };

declare module '@labelconsole/core/queue' {
  interface JobMap {
    /**
     * `interaction.token` is the short-lived (15 minute) interaction token; the
     * logger redacts keys named `token`.
     */
    'discord.interaction': { interaction: { id: string; applicationId: string; token: string }; userId: string; discordUserId: string; command?: string; action: DiscordAction };
    'discord.register-commands': { requestedBy: string };
    /** Daily: drop old lookup logs, used link codes and evidence past its retention in every label. */
    'discord.purge': Record<string, never>;
    /** Look up a sample of the label's own songs through every source and score each source. */
    'discord.benchmark': { benchmarkId: string };
    /** Daily: queue `discord.readings` for every label that keeps daily readings. */
    'discord.readings-all': Record<string, never>;
    /** One label's daily play-count readings for recently looked-up songs. */
    'discord.readings': { limit: number };
  }
}
