import type { FieldSpec } from '@labelconsole/ui/client';
import { CONTRACT_STATUSES, DOCUMENT_TYPES, type ContractStatus, type ContractTerms } from '../schema';

export const TYPE_LABEL: Record<(typeof DOCUMENT_TYPES)[number], string> = { contract: 'Contract', statement: 'Statement', other: 'Document' };
export const STATUS_LABEL: Record<ContractStatus, string> = { draft: 'Unsigned', sent: 'Sent · awaiting', signed: 'Signed', expired: 'Expired', terminated: 'Terminated' };
export const KIND_LABEL: Record<string, string> = { expiry: 'Term ends', option: 'Option', renewal: 'Renewal', notice: 'Notice deadline', payment: 'Payment', other: 'Date' };

export const EXTRACTION_LABEL: Record<string, string> = { none: '—', queued: 'Queued', running: 'Reading…', done: 'Read', failed: 'Failed' };

/** Chip class for the contract status column; matches the design's tones. */
export function statusChip(label: string) {
  if (label === 'Signed') return 'lc-chip lc-chip--blue';
  if (label === 'Unsigned' || label === 'Expired' || label === 'Terminated') return 'lc-chip lc-chip--red';
  if (label.startsWith('Expiring')) return 'lc-chip lc-chip--ink';
  return 'lc-chip';
}

/** "40 / 60": artist share / label share, as the design shows it. */
export function rateLabel(t: Pick<ContractTerms, 'royaltyArtistPct' | 'royaltyLabelPct'> | null | undefined) {
  if (!t || t.royaltyArtistPct == null) return '—';
  const label = t.royaltyLabelPct ?? 100 - t.royaltyArtistPct;
  return `${trim(t.royaltyArtistPct)} / ${trim(label)}`;
}
const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function uploadFields(opts: { canConfidential: boolean; canFinancial: boolean; type?: string }): FieldSpec[] {
  const types = DOCUMENT_TYPES.filter((t) => t !== 'statement' || opts.canFinancial);
  return [
    { name: 'file', label: 'File', type: 'file', required: true, full: true, accept: '.pdf,.csv,.txt,.doc,.docx,.xlsx,.png,.jpg', hint: 'Contracts as PDF are read automatically. Statements can be the distributor’s detailed report as .xlsx, CSV or PDF.' },
    { name: 'type', label: 'Type', type: 'select', required: true, options: types.map((t) => ({ value: t, label: TYPE_LABEL[t] })) },
    { name: 'title', label: 'Title', placeholder: 'Defaults to the file name' },
    { name: 'contractStatus', label: 'Contract status', type: 'select', options: CONTRACT_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })), hint: 'Contracts only' },
    { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'comma separated' },
    ...(opts.canConfidential ? [{ name: 'confidential', label: 'Confidential: only people with confidential access can open it', type: 'checkbox' as const, full: true }] : []),
  ];
}

export function documentFields(opts: { canConfidential: boolean; contract: boolean }): FieldSpec[] {
  return [
    { name: 'title', label: 'Title', required: true, full: true },
    ...(opts.contract
      ? [
          { name: 'contractStatus', label: 'Status', type: 'select' as const, options: CONTRACT_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })) },
          { name: 'signedAt', label: 'Signed on', type: 'date' as const },
          { name: 'effectiveDate', label: 'Effective from', type: 'date' as const },
          { name: 'expiryDate', label: 'Expires', type: 'date' as const },
        ]
      : []),
    { name: 'tags', label: 'Tags', type: 'tags', full: true },
    ...(opts.canConfidential ? [{ name: 'confidential', label: 'Confidential', type: 'checkbox' as const, full: true }] : []),
  ];
}

/** "Dec 2026" */
export function monthYear(d: string) {
  const x = new Date(d.length === 7 ? `${d}-01T00:00:00Z` : `${d.slice(0, 10)}T00:00:00Z`);
  return `${x.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${x.getUTCFullYear()}`;
}

/** A statement period: "Jul 2026", "Jun–Jul 2026" or "Dec 2025–Jan 2026". */
export function periodLabel(start: string | null | undefined, end: string | null | undefined) {
  if (!start) return '—';
  const a = monthYear(start);
  if (!end || end.slice(0, 7) <= start.slice(0, 7)) return a;
  const b = monthYear(end);
  return start.slice(0, 4) === end.slice(0, 4) ? `${a.slice(0, 3)}–${b}` : `${a}–${b}`;
}
