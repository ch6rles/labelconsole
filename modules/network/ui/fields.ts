import type { FieldSpec } from '@labelconsole/ui/client';
import { CONTACT_STAGES, CONTACT_TYPES } from '../schema';

export const TYPE_LABEL: Record<(typeof CONTACT_TYPES)[number], string> = { creator: 'Creator', editor: 'Playlist editor', curator: 'Curator', press: 'Press', other: 'Other' };
export const STAGE_LABEL: Record<(typeof CONTACT_STAGES)[number], string> = { lead: 'Lead', contacted: 'Contacted', engaged: 'Engaged', active: 'Active', dormant: 'Dormant', do_not_contact: 'Do not contact' };
export const HANDLE_KEYS = ['instagram', 'tiktok', 'youtube', 'x', 'spotify', 'twitch', 'website'] as const;

export const contactFields: FieldSpec[] = [
  { name: 'name', label: 'Name', required: true },
  { name: 'type', label: 'Type', type: 'select', required: true, options: CONTACT_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })) },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'organization', label: 'Organisation / outlet' },
  { name: 'handles', label: 'Handles', type: 'json', full: true, rows: 4, hint: '{"tiktok": "@name", "instagram": "name", "youtube": "channel"}' },
  { name: 'audienceSize', label: 'Audience', type: 'number', min: 0 },
  { name: 'genres', label: 'Genres', type: 'tags' },
  { name: 'rateCents', label: 'Typical rate', type: 'money', hint: 'Per post or placement' },
  { name: 'currency', label: 'Currency' },
  { name: 'stage', label: 'Relationship', type: 'select', required: true, options: CONTACT_STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] })) },
  { name: 'country', label: 'Country (2 letters)' },
  { name: 'payoutEmail', label: 'Payout email (PayPal)', type: 'email' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const playlistFields = (contactOptions: Array<{ value: string; label: string }>): FieldSpec[] => [
  { name: 'name', label: 'Playlist', required: true },
  { name: 'platform', label: 'Platform', type: 'select', required: true, options: ['spotify', 'apple_music', 'youtube', 'deezer', 'soundcloud', 'other'].map((p) => ({ value: p, label: p.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()) })) },
  { name: 'contactId', label: 'Curator', type: 'select', options: contactOptions },
  { name: 'followers', label: 'Followers', type: 'number', min: 0 },
  { name: 'url', label: 'Link', type: 'url', full: true },
  { name: 'genres', label: 'Genres', type: 'tags', full: true },
];

export function handleUrl(key: string, v: string) {
  if (/^https?:\/\//.test(v)) return v;
  switch (key) {
    case 'instagram':
      return `https://instagram.com/${v}`;
    case 'tiktok':
      return `https://www.tiktok.com/@${v}`;
    case 'youtube':
      return `https://www.youtube.com/@${v}`;
    case 'x':
      return `https://x.com/${v}`;
    case 'twitch':
      return `https://twitch.tv/${v}`;
    default:
      return null;
  }
}
