import type { FieldSpec } from '@labelconsole/ui/client';
import { CAMPAIGN_STATUSES } from '../schema';

export type Option = { value: string; label: string };

export const STATUS_LABEL: Record<(typeof CAMPAIGN_STATUSES)[number], string> = { planning: 'Planning', active: 'Active', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled' };
export const statusChip = (s: string) => (s === 'active' ? 'lc-chip lc-chip--blue' : s === 'cancelled' ? 'lc-chip lc-chip--muted' : s === 'paused' ? 'lc-chip lc-chip--ink' : 'lc-chip');

export const PITCH_LABEL: Record<string, string> = { draft: 'Draft', approved: 'Queued to send', sending: 'Sending…', sent: 'Sent', opened: 'Opened', replied: 'Replied', accepted: 'Accepted', declined: 'Declined' };
export const pitchChip = (s: string) => (s === 'accepted' ? 'lc-chip lc-chip--blue' : s === 'declined' ? 'lc-chip lc-chip--muted' : s === 'replied' || s === 'opened' ? 'lc-chip lc-chip--outline-blue' : s === 'draft' ? 'lc-chip' : 'lc-chip lc-chip--ink');

export const campaignFields = (releases: Option[]): FieldSpec[] => [
  { name: 'name', label: 'Name', required: true, full: true },
  { name: 'releaseId', label: 'Release', type: 'select', options: releases },
  { name: 'status', label: 'Status', type: 'select', required: true, options: CAMPAIGN_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })) },
  { name: 'startDate', label: 'Starts', type: 'date' },
  { name: 'endDate', label: 'Ends', type: 'date' },
  { name: 'budgetCents', label: 'Budget', type: 'money' },
  { name: 'currency', label: 'Currency' },
  { name: 'goals', label: 'Goals', type: 'textarea' },
  { name: 'kpis', label: 'KPIs', type: 'json', rows: 5, hint: '[{"name": "Plays during campaign", "target": 250000, "unit": "plays", "metric": "streams"}] · metrics: streams, views, posts, adds, custom (with "actual")' },
];

export const cardFields = (contacts: Option[], stages: Option[], canSpend: boolean): FieldSpec[] => [
  { name: 'title', label: 'Title', required: true, full: true, placeholder: 'e.g. 2 TikToks using the hook' },
  { name: 'contactId', label: 'Creator / contact', type: 'select', options: contacts },
  { name: 'stage', label: 'Stage', type: 'select', required: true, options: stages },
  { name: 'dueDate', label: 'Due', type: 'date' },
  { name: 'deliverablesOrdered', label: 'Posts ordered', type: 'number', min: 0 },
  { name: 'deliverablesDelivered', label: 'Posts delivered', type: 'number', min: 0 },
  ...(canSpend
    ? [
        { name: 'offerCents', label: 'Offer', type: 'money' as const },
        { name: 'paidCents', label: 'Paid', type: 'money' as const, hint: 'Recording a payment stamps the payment date' },
      ]
    : []),
  { name: 'proofUrls', label: 'Proof (post links)', type: 'tags', full: true, hint: 'Comma separated URLs of the delivered posts' },
  { name: 'measuredViews', label: 'Measured views', type: 'number', min: 0 },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export const pitchFields = (o: { contacts: Option[]; campaigns: Option[]; playlists: Option[]; tracks: Option[] }): FieldSpec[] => [
  { name: 'contactId', label: 'To', type: 'select', required: true, options: o.contacts },
  { name: 'campaignId', label: 'Campaign', type: 'select', options: o.campaigns },
  { name: 'playlistId', label: 'Playlist', type: 'select', options: o.playlists },
  { name: 'trackId', label: 'Track', type: 'select', options: o.tracks },
  { name: 'subject', label: 'Subject', required: true, full: true },
  { name: 'body', label: 'Message', type: 'textarea', required: true, rows: 8 },
];
