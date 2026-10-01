import { z } from 'zod';
import { compact, defineTool } from '@labelconsole/core/tools';
import { CAMPAIGN_STATUSES } from '../schema';
import * as svc from '../service';

export const tools = [
  defineTool({
    name: 'marketing_list_campaigns',
    module: 'marketing',
    description: 'List campaigns with their release, dates, budget, bookings, spend, delivered posts, measured views, cost per 1,000 views and outreach results.',
    input: z.object({ status: z.enum(CAMPAIGN_STATUSES).optional() }),
    permission: 'marketing:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) =>
        compact(
          (await svc.listCampaigns(ctx, { status: i.status })).map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            release: c.releaseTitle,
            startDate: c.startDate,
            endDate: c.endDate,
            budget: `${(c.budgetCents / 100).toFixed(2)} ${c.currency}`,
            bookings: c.stats.bookings,
            paid: `${(c.stats.paidCents / 100).toFixed(2)} ${c.currency}`,
            postsDelivered: `${c.stats.delivered} of ${c.stats.ordered}`,
            measuredViews: c.stats.views,
            costPer1kViews: c.stats.costPer1kCents != null ? (c.stats.costPer1kCents / 100).toFixed(2) : null,
            pitchesSent: c.stats.pitchesSent,
            playlistAdds: c.stats.accepted,
          })),
        ),
      ),
  }),
  defineTool({
    name: 'marketing_create_campaign',
    module: 'marketing',
    description: 'Create a campaign in planning status, optionally tied to a release, with goals, budget, dates and KPIs. A creator board is created with it.',
    input: z.object({
      name: z.string().min(1).max(200),
      releaseId: z.uuid().optional(),
      goals: z.string().max(3000).optional(),
      budgetCents: z.number().int().min(0).default(0),
      startDate: z.iso.date().optional(),
      endDate: z.iso.date().optional(),
      kpis: z.array(z.object({ name: z.string(), target: z.number(), unit: z.string().default(''), metric: z.enum(['streams', 'views', 'posts', 'adds', 'custom']).default('custom') })).max(8).default([]),
    }),
    permission: 'marketing:write',
    risk: 'write',
    preview: (i) => `Create campaign "${i.name}"${i.budgetCents ? ` with a ${(i.budgetCents / 100).toFixed(2)} budget` : ''}`,
    execute: (t, i) => t.withOrg(async (ctx) => {
      const c = await svc.createCampaign(ctx, { ...i, status: 'planning' });
      return { id: c.id, name: c.name, status: c.status };
    }),
  }),
  defineTool({
    name: 'marketing_add_pipeline_card',
    module: 'marketing',
    description: 'Add a card to a pipeline board (give boardId, or campaignId to use that campaign\'s creator board), for example a creator to approach. Agents cannot set offers or payments; put a proposed fee in the notes for a person to decide.',
    input: z.object({ boardId: z.uuid().optional(), campaignId: z.uuid().optional(), title: z.string().min(1).max(300), contactId: z.uuid().optional(), stage: z.string().max(40).optional(), dueDate: z.iso.date().optional(), notes: z.string().max(3000).optional() }).refine((v) => v.boardId || v.campaignId, 'Give a boardId or a campaignId'),
    permission: 'marketing:write',
    risk: 'write',
    preview: (i) => `Add "${i.title}" to ${i.boardId ? 'a pipeline board' : 'the campaign creator board'}`,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const boardId = i.boardId ?? (await svc.creatorBoardFor(ctx, i.campaignId!)).id;
        const card = await svc.createCard(ctx, { boardId, title: i.title, contactId: i.contactId ?? null, stage: i.stage, dueDate: i.dueDate ?? null, notes: i.notes ?? null, campaignId: i.campaignId ?? null });
        return { id: card.id, boardId, stage: card.stage };
      }),
  }),
  defineTool({
    name: 'marketing_move_pipeline_card',
    module: 'marketing',
    description: 'Move a pipeline card to another stage on its board (stage IDs come from the board, e.g. prospect, offered, booked, posted, paid).',
    input: z.object({ cardId: z.uuid(), stage: z.string().min(1).max(40) }),
    permission: 'marketing:write',
    risk: 'write',
    idempotent: true,
    preview: (i) => `Move card ${i.cardId} to "${i.stage}"`,
    execute: (t, i) => t.withOrg(async (ctx) => ({ id: (await svc.moveCard(ctx, i.cardId, { stage: i.stage, position: 0 })).id, stage: i.stage })),
  }),
  defineTool({
    name: 'marketing_draft_outreach',
    module: 'marketing',
    description: 'Draft a personalised pitch email to a playlist editor, curator, creator or journalist. Drafting never sends; sending is a separate step that a person approves.',
    input: z.object({ contactId: z.uuid(), campaignId: z.uuid().optional(), playlistId: z.uuid().optional(), trackId: z.uuid().optional(), subject: z.string().min(1).max(200), body: z.string().min(1).max(8000) }),
    permission: 'marketing:write',
    risk: 'write',
    preview: (i) => `Draft pitch "${i.subject}"`,
    execute: (t, i) => t.withOrg(async (ctx) => ({ id: (await svc.createPitch(ctx, i)).id, status: 'draft' })),
  }),
  defineTool({
    name: 'marketing_send_outreach',
    module: 'marketing',
    description: 'Send a drafted pitch by email from the label mailbox. Always waits for a person to approve the exact message first.',
    input: z.object({ pitchId: z.uuid() }),
    permission: 'marketing:write',
    risk: 'external',
    requiresApproval: true,
    idempotent: true,
    preview: (i) => `Send pitch ${i.pitchId} by email`,
    execute: (t, i) => t.withOrg(async (ctx) => ({ id: (await svc.sendPitch(ctx, i.pitchId)).id, status: 'queued to send' })),
  }),
];
