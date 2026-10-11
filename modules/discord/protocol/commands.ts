import { CommandType, ContextType, IntegrationType, OptionType } from './types';

/** The message context-menu command ("Apps → Look Up Song" on a message). */
export const MESSAGE_COMMAND = 'Look Up Song';

/**
 * The command set, for the install types the app has switched on. With a user
 * install the commands work in servers and every kind of DM; a server install
 * alone covers servers and DMs with the app.
 */
export function commandDefinitions(integrationTypes: number[] = [IntegrationType.GUILD_INSTALL, IntegrationType.USER_INSTALL]) {
  const where = {
    integration_types: integrationTypes,
    contexts: integrationTypes.includes(IntegrationType.USER_INSTALL) ? [ContextType.GUILD, ContextType.BOT_DM, ContextType.PRIVATE_CHANNEL] : [ContextType.GUILD, ContextType.BOT_DM],
  };
  return [
    {
      name: 'song',
      type: CommandType.CHAT_INPUT,
      description: 'Look up a song or release by link, ISRC, UPC or name',
      options: [
        { type: OptionType.STRING, name: 'query', description: 'A Spotify, Apple Music, Deezer or YouTube link, an ISRC, a UPC, or "Artist - Title"', required: true, max_length: 300 },
        { type: OptionType.STRING, name: 'artist', description: 'The artist, to narrow a search by title', required: false, max_length: 100 },
      ],
      ...where,
    },
    {
      name: 'link',
      type: CommandType.CHAT_INPUT,
      description: 'Connect your Discord account to Label Console',
      options: [{ type: OptionType.STRING, name: 'code', description: 'The code from Label Console → Settings → Discord', required: true, min_length: 8, max_length: 20 }],
      ...where,
    },
    { name: 'unlink', type: CommandType.CHAT_INPUT, description: 'Disconnect your Discord account from Label Console', ...where },
    { name: MESSAGE_COMMAND, type: CommandType.MESSAGE, ...where },
  ];
}
