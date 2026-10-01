import type { FieldSpec } from '@labelconsole/ui/client';
import { RELEASE_STATUSES, RELEASE_TYPES } from '../schema';

export const TYPE_LABEL: Record<string, string> = { single: 'Single', ep: 'EP', album: 'Album', compilation: 'Compilation' };
export const STATUS_LABEL: Record<string, string> = { collecting: 'Collecting', draft: 'Draft', scheduled: 'Scheduled', live: 'Live', taken_down: 'Taken down' };

export function releaseFields(artistOptions: Array<{ value: string; label: string }>): FieldSpec[] {
  return [
    { name: 'title', label: 'Title', required: true },
    { name: 'type', label: 'Type', type: 'select', required: true, options: RELEASE_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })) },
    { name: 'artistIds', label: 'Artists', type: 'multiselect', options: artistOptions, full: true },
    { name: 'releaseDate', label: 'Release date', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', required: true, options: RELEASE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })) },
    { name: 'upc', label: 'UPC / EAN' },
    { name: 'catalogNumber', label: 'Catalogue number', placeholder: 'Cat125' },
    { name: 'labelName', label: 'Label name (as on DSPs)' },
    { name: 'distributor', label: 'Distributor' },
    { name: 'pLine', label: '℗ line' },
    { name: 'cLine', label: '© line' },
    { name: 'genre', label: 'Genre' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

export function trackFields(artistOptions: Array<{ value: string; label: string }>): FieldSpec[] {
  return [
    { name: 'title', label: 'Title', required: true },
    { name: 'version', label: 'Version', placeholder: 'Radio Edit' },
    { name: 'artistIds', label: 'Artists', type: 'multiselect', options: artistOptions, full: true },
    { name: 'isrc', label: 'ISRC', placeholder: 'NL-A1Z-26-00123' },
    { name: 'durationMs', label: 'Duration (ms)', type: 'number' },
    { name: 'explicit', label: 'Explicit', type: 'checkbox' },
    { name: 'genre', label: 'Genre' },
    { name: 'bpm', label: 'BPM', type: 'number' },
    { name: 'musicalKey', label: 'Key' },
    { name: 'language', label: 'Language', placeholder: 'en' },
  ];
}
