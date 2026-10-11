import { CommandType, ContextType, IntegrationType, OptionType } from './types';

/** The message context-menu command ("Apps → Look Up Song" on a message). */
export const MESSAGE_COMMAND = 'Look Up Song';

/** Fields a correction can be about, for /correct and the Report / Correct form. */
export const CORRECTABLE_FIELDS = [
  { value: 'title', name: 'Title' },
  { value: 'artists', name: 'Artists' },
  { value: 'isrc', name: 'ISRC' },
  { value: 'upc', name: 'UPC' },
  { value: 'releaseTitle', name: 'Release title' },
  { value: 'releaseDate', name: 'Release date' },
  { value: 'labelName', name: 'Label' },
  { value: 'pLine', name: '℗ line' },
  { value: 'cLine', name: '© line' },
  { value: 'distributor', name: 'Distributor / licensor' },
  { value: 'credits', name: 'Credits' },
  { value: 'other', name: 'Something else' },
] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number]['value'];

const str = (name: string, description: string, required = true, max = 300) => ({ type: OptionType.STRING, name, description, required, max_length: max });
const share = { type: OptionType.BOOLEAN, name: 'share', description: 'Post the card in this channel for everyone (it is private to you otherwise)', required: false };

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
      description: 'Look up a song by link, ISRC, UPC or name',
      options: [str('query', 'A Spotify, Apple Music, Deezer or YouTube link, an ISRC, or "Artist - Title"'), str('artist', 'The artist, to narrow a search by title', false, 100), share],
      ...where,
    },
    {
      name: 'release',
      type: CommandType.CHAT_INPUT,
      description: 'Look up an album, EP or single: UPC, tracklist, label and copyright lines',
      options: [str('query', 'An album link, a UPC/EAN, or "Artist - Title"'), str('artist', 'The artist, to narrow a search by title', false, 100), share],
      ...where,
    },
    { name: 'artist', type: CommandType.CHAT_INPUT, description: 'Show an artist: identity, releases and whether they are on your roster', options: [str('query', 'The artist name, or a Deezer artist link', true, 100), share], ...where },
    { name: 'label', type: CommandType.CHAT_INPUT, description: 'Show a record label and the releases linked to it', options: [str('query', 'The label name', true, 100), share], ...where },
    { name: 'licensor', type: CommandType.CHAT_INPUT, description: 'Show what your records verify about a distributor or licensor', options: [str('query', 'The distributor or licensor name', true, 100)], ...where },
    {
      name: 'compare',
      type: CommandType.CHAT_INPUT,
      description: 'Compare two songs or releases and highlight what differs',
      options: [str('first', 'A link, ISRC or UPC'), str('second', 'A link, ISRC or UPC'), share],
      ...where,
    },
    {
      name: 'correct',
      type: CommandType.CHAT_INPUT,
      description: 'Suggest a correction for review by the label; nothing is changed until someone approves it',
      options: [
        str('target', 'A link, ISRC or UPC of the song or release'),
        { type: OptionType.STRING, name: 'field', description: 'What is wrong', required: true, choices: CORRECTABLE_FIELDS.map((f) => ({ name: f.name, value: f.value })) },
        str('value', 'The correct value', true, 500),
        str('note', 'Where this comes from (a document, a link…)', false, 500),
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
