import type { FieldSpec } from '@labelconsole/ui/client';
import { ARTIST_STATUSES } from '../schema';

export const artistFields: FieldSpec[] = [
  { name: 'name', label: 'Artist name', required: true },
  { name: 'legalName', label: 'Legal name' },
  { name: 'status', label: 'Status', type: 'select', required: true, options: ARTIST_STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })) },
  { name: 'country', label: 'Country (ISO code)', placeholder: 'NL' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'manager', label: 'Management', placeholder: 'Self-managed' },
  { name: 'payoutMethod', label: 'Payout method', type: 'select', required: true, options: [{ value: 'bank', label: 'Bank' }, { value: 'paypal', label: 'PayPal' }, { value: 'none', label: 'Missing' }] },
  { name: 'rosterSince', label: 'On roster since', type: 'date' },
  { name: 'aliases', label: 'Aliases', type: 'tags', hint: 'Comma separated' },
  { name: 'spotifyArtistId', label: 'Spotify artist ID' },
  { name: 'youtubeChannelId', label: 'YouTube channel ID' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];
