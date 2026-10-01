import { RISK_LEVELS } from '@labelconsole/core/tools';

export const RUN_STATUS: Record<string, { label: string; className: string }> = {
  queued: { label: 'Queued', className: 'lc-chip' },
  running: { label: 'Running', className: 'lc-chip lc-chip--blue' },
  waiting_approval: { label: 'Needs approval', className: 'lc-chip lc-chip--red' },
  waiting_child: { label: 'Waiting on agent', className: 'lc-chip lc-chip--ink' },
  paused: { label: 'Paused', className: 'lc-chip lc-chip--muted' },
  completed: { label: 'Completed', className: 'lc-chip lc-chip--outline-blue' },
  failed: { label: 'Failed', className: 'lc-chip lc-chip--red' },
  stopped: { label: 'Stopped', className: 'lc-chip lc-chip--muted' },
  budget_exceeded: { label: 'Over budget', className: 'lc-chip lc-chip--red' },
};

export const RunChip = ({ status }: { status: string }) => <span className={RUN_STATUS[status]?.className ?? 'lc-chip'}>{RUN_STATUS[status]?.label ?? status}</span>;

export const RISK_LABEL: Record<(typeof RISK_LEVELS)[number], string> = {
  read: 'Read data',
  write: 'Change records',
  external: 'Contact people outside the label',
  destructive: 'Delete things',
  spend: 'Spend money',
};

export const TRIGGER_LABEL: Record<string, string> = { manual: 'Manual', cron: 'Schedule', event: 'Event', webhook: 'Webhook', delegation: 'Delegated' };

/** Short money for chart labels: cents under a dollar. */
export const usdShort = (v: number) => (!v ? '' : v < 1 ? `${Math.max(1, Math.round(v * 100))}¢` : `$${v.toFixed(v < 10 ? 1 : 0)}`);

export const usd = (n: number | string) => {
  const v = Number(n);
  return v === 0 ? '$0' : v < 0.01 ? '<$0.01' : `$${v.toFixed(v < 10 ? 2 : 0)}`;
};

/** Events agents can be triggered by, for the trigger form. */
export const TRIGGER_EVENTS = [
  'catalogue.release.created',
  'catalogue.track.created',
  'catalogue.demo.submitted',
  'marketing.campaign.started',
  'marketing.pitch.sent',
  'streams.alert',
  'documents.document.uploaded',
  'documents.statement.parsed',
  'documents.key_date.due',
  'people.artist.status_changed',
  'network.contact.created',
];

/** Readable cron presets. */
export const CRON_PRESETS = [
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 9 * * *', label: 'Daily at 09:00' },
  { value: '0 8 * * 1', label: 'Mondays at 08:00' },
  { value: '0 7 1 * *', label: 'Monthly on the 1st' },
];

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** Plain-English cron for the common shapes; anything else is shown as written. */
export function describeCron(cron: string) {
  const preset = CRON_PRESETS.find((p) => p.value === cron);
  if (preset) return preset.label;
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : null);
  const m = num(min);
  const h = num(hour);
  if (mon !== '*' || m == null) return cron;
  if (hour?.startsWith('*/') && dom === '*' && dow === '*') return `Every ${hour.slice(2)} hours`;
  if (h == null) return cron;
  const at = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (dom === '*' && dow === '*') return `Daily at ${at}`;
  if (dom === '*' && num(dow) != null) return `${DAYS[num(dow)! % 7]} at ${at}`;
  if (dow === '*' && num(dom) != null) return `Monthly on the ${ordinal(num(dom)!)} at ${at}`;
  if (dom === '*' && dow === '1-5') return `Weekdays at ${at}`;
  return cron;
}
