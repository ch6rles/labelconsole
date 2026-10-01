import '../types';
import { and, eq, isNull } from 'drizzle-orm';
import { isTransient } from '@labelconsole/core/errors';
import { sendMail } from '@labelconsole/core/mail';
import { defineJob } from '@labelconsole/core/queue';
import { contacts } from '@labelconsole/network/schema';
import { logInteraction } from '@labelconsole/network/service';
import { pitches } from '../schema';

export const jobs = [
  /** Send one approved pitch by email through the label's SMTP account. */
  defineJob('marketing.send-pitch', async (job, data) => {
    // Claim the pitch first (approved → sending) so a retry, a duplicate job or
    // a crash after the email left can never send it twice. At most once.
    const p = await job.withOrg(async (ctx) => {
      const [claimed] = await ctx.tx.update(pitches).set({ status: 'sending' }).where(and(eq(pitches.id, data.pitchId), eq(pitches.status, 'approved'), isNull(pitches.sentAt))).returning();
      if (!claimed) return null;
      const [c] = await ctx.tx.select().from(contacts).where(eq(contacts.id, claimed.contactId));
      return { pitch: claimed, contact: c };
    });
    if (!p) return { skipped: true };
    const release = (outcome: string) => job.withOrg((ctx) => ctx.tx.update(pitches).set({ status: 'approved', outcome }).where(eq(pitches.id, p.pitch.id)));
    if (!p.contact?.email || p.contact.stage === 'do_not_contact' || p.contact.goneAt) {
      await job.withOrg((ctx) => ctx.tx.update(pitches).set({ status: 'draft', outcome: `Not sent: ${!p.contact?.email ? 'no email address' : p.contact.goneAt ? 'account gone' : 'contact asked not to be contacted'}` }).where(eq(pitches.id, p.pitch.id)));
      return { skipped: true };
    }
    let messageId: string;
    try {
      ({ messageId } = await job.withOrg((ctx) => sendMail(ctx, { to: p.contact!.email!, subject: p.pitch.subject ?? '', text: p.pitch.body ?? '' })));
    } catch (err) {
      // Nothing left the mailbox: put the pitch back so a retry (or a person) can send it.
      await release(`Not sent yet: ${(err as Error).message.slice(0, 300)}`);
      if (isTransient(err)) throw err;
      return { failed: true };
    }
    await job.withOrg(async (ctx) => {
      await ctx.tx.update(pitches).set({ status: 'sent', sentAt: new Date(), outcome: null }).where(eq(pitches.id, p.pitch.id));
      await logInteraction(ctx, p.pitch.contactId, { channel: 'email', direction: 'outbound', summary: `Pitch sent: ${p.pitch.subject}`, campaignId: p.pitch.campaignId });
      await ctx.audit({ action: 'pitch.sent', module: 'marketing', targetType: 'pitch', targetId: p.pitch.id, targetLabel: `${p.contact!.name}: ${p.pitch.subject}`, after: { messageId } });
      await ctx.emit('marketing.pitch.sent', { pitchId: p.pitch.id, contactId: p.pitch.contactId, campaignId: p.pitch.campaignId });
    });
    return { sent: true };
  }),
];
