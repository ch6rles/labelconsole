export {};

/** What a deferred interaction asks the worker to do. */
export type DiscordAction =
  /** /song or "Look Up Song": a link, ISRC, UPC or text. */
  | { kind: 'lookup'; input: string; artist?: string | null }
  /** A choice from the "Which one?" list: `dz:<id>` or `isrc:<ISRC>`. */
  | { kind: 'pick'; key: string }
  /** A button on a card: switch to another view of the same track or release. */
  | { kind: 'view'; view: string; ref: string };

declare module '@labelconsole/core/queue' {
  interface JobMap {
    /**
     * `interaction.token` is the short-lived (15 minute) interaction token; the
     * logger redacts keys named `token`.
     */
    'discord.interaction': { interaction: { id: string; applicationId: string; token: string }; userId: string; discordUserId: string; action: DiscordAction };
    'discord.register-commands': { requestedBy: string };
    'discord.purge-codes': Record<string, never>;
  }
}
