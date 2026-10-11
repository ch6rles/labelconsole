/**
 * Pure rendering: lookups become Discord messages. The pieces live in
 * `cards/`; this file re-exports them and reads component ids back.
 */
import { PICK_IDS } from './cards/entities';
import { VIEWS, type View } from './cards/song';
import type { DiscordAction } from './types';

export * from './cards/format';
export * from './cards/song';
export * from './cards/views';
export * from './cards/entities';
export * from './cards/logos';

const ISRC = '[A-Z]{2}[A-Z0-9]{3}\\d{7}';
const REF = new RegExp(`^(?:isrc:${ISRC}|upc:\\d{12,14})$`);
const SONG_KEY = new RegExp(`^(?:dz:\\d{1,20}|dza:\\d{1,20}|isrc:${ISRC})$`);

/** Read a component's custom_id (and a select's value) back into an action; anything else is refused. */
export function parseCustomId(customId: string, values: string[] | undefined): DiscordAction | null {
  const shared = customId.endsWith(':s');
  const base = shared ? customId.slice(0, -2) : customId;
  const value = values?.[0] ?? '';
  if (base === PICK_IDS.song) return SONG_KEY.test(value) ? { kind: 'pick', key: value, shared } : null;
  if (base === PICK_IDS.artist) return /^dzar:\d{1,20}$/.test(value) ? { kind: 'pickArtist', key: value, shared } : null;
  if (base === PICK_IDS.label) return /^mbl:[0-9a-f-]{36}$/.test(value) ? { kind: 'pickLabel', key: value, shared } : null;
  const m = /^lc:v:([a-z]+):(.+)$/.exec(customId);
  if (!m || !(VIEWS as readonly string[]).includes(m[1]) || !REF.test(m[2])) return null;
  return { kind: 'view', view: m[1] as View, ref: m[2] };
}
