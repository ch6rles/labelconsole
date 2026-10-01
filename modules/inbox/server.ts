import './types';
import '@labelconsole/agents/types';
import { defineListener, defineModule } from '@labelconsole/core/modules';
import { tools } from './agent-tools';
import { routes } from './api';
import { manifest } from './manifest';
import { notify, unreadCount } from './service';

/**
 * Inbox turns other modules' events into notifications. It only depends on
 * event payloads, never on those modules' tables.
 */
const listeners = [
  defineListener({
    id: 'inbox.approval-requested',
    event: 'agents.approval.requested',
    handle: async (ctx, e) => {
      const p = e.payload;
      await notify(ctx, { userIds: [p.ownerUserId], permission: 'agents:approve', kind: 'approval', title: `${p.agentName} needs approval`, body: p.preview, href: '/inbox/approvals', entityType: 'approval', entityId: p.approvalId, dedupeKey: `approval:${p.approvalId}` });
    },
  }),
  defineListener({
    id: 'inbox.run-failed',
    event: 'agents.run.failed',
    handle: async (ctx, e) => {
      const p = e.payload;
      await notify(ctx, { userIds: [p.ownerUserId], kind: 'agent', title: `${p.agentName} ${p.status === 'budget_exceeded' ? 'hit its budget' : 'failed'}`, body: p.error.slice(0, 300), href: `/agents/runs/${p.runId}`, entityType: 'agent_run', entityId: p.runId, dedupeKey: `run-failed:${p.runId}` });
    },
  }),
  defineListener({
    id: 'inbox.stream-alert',
    event: 'streams.alert' as never,
    handle: async (ctx, e) => {
      const p = e.payload as unknown as { alertId: string; trackId: string; trackTitle: string; message: string };
      await notify(ctx, { permission: 'streams:manage', kind: 'alert', title: p.trackTitle, body: p.message, href: `/streams/tracks/${p.trackId}`, entityType: 'stream_alert', entityId: p.alertId, dedupeKey: `stream-alert:${p.alertId}` });
    },
  }),
  defineListener({
    id: 'inbox.key-date-due',
    event: 'documents.key_date.due' as never,
    handle: async (ctx, e) => {
      const p = e.payload as unknown as { keyDateId: string; documentId: string; title: string; date: string; daysLeft: number; kind: string };
      await notify(ctx, {
        permission: 'documents:write',
        kind: 'reminder',
        title: `${p.kind === 'option' ? 'Option date' : p.kind === 'expiry' ? 'Contract expires' : 'Key date'} in ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}`,
        body: `${p.title} · ${p.date}`,
        href: `/documents/${p.documentId}`,
        entityType: 'key_date',
        entityId: p.keyDateId,
        dedupeKey: `key-date:${p.keyDateId}:${p.daysLeft}`,
      });
    },
  }),
  defineListener({
    id: 'inbox.demo-submitted',
    event: 'catalogue.demo.submitted' as never,
    handle: async (ctx, e) => {
      const p = e.payload as unknown as { demoId: string; title: string; artistName: string; source: string };
      if (p.source === 'manual') return;
      await notify(ctx, { permission: 'catalogue:write', kind: 'assignment', title: `New demo: ${p.title}`, body: `From ${p.artistName}`, href: `/catalog/demos?open=${p.demoId}`, entityType: 'demo', entityId: p.demoId, dedupeKey: `demo:${p.demoId}` });
    },
  }),
  defineListener({
    id: 'inbox.export-ready',
    event: 'settings.export.ready' as never,
    handle: async (ctx, e) => {
      const p = e.payload as unknown as { exportId: string; requestedBy: string | null };
      const userId = p.requestedBy?.startsWith('user:') ? p.requestedBy.slice(5) : null;
      if (!userId) return;
      await notify(ctx, { userIds: [userId], kind: 'system', title: 'Your data export is ready', href: '/settings/export', dedupeKey: `export:${p.exportId}` });
    },
  }),
];

export default defineModule({
  manifest,
  routes,
  listeners,
  tools,
  shell: async (ctx, userId) => ({ unread: await unreadCount(ctx, userId) }),
});
