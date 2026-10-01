import { withSystemOrg } from '@labelconsole/core/context';
import { RateLimitedError, ValidationError } from '@labelconsole/core/errors';
import { tryAcquire } from '@labelconsole/core/ratelimit';
import { clientIp, errorResponse, json } from '@labelconsole/core/router';
import { createDemo } from '@labelconsole/catalogue/service';
import { ensureSystemFolder, storeFile } from '@labelconsole/drive/service';
import { orgForIntakeToken } from '@/server/intake';
import '@/server/modules';

export const dynamic = 'force-dynamic';

/** Public demo submission: no session, scoped to the label that owns the token. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const rl = await tryAcquire(`intake:${clientIp(req) ?? 'unknown'}`, { capacity: 5, refillPerSec: 1 / 120 });
    if (!rl.allowed) throw new RateLimitedError(rl.waitMs, 'Too many submissions from this address. Try again later.');
    const org = await orgForIntakeToken(token);
    if (!org) return json({ error: { code: 'not_found', message: 'This submission link is not valid' } }, 404);
    const form = await req.formData();
    if (form.get('website')) return json({ ok: true }); // honeypot field: bots fill it, people never see it
    const title = String(form.get('title') ?? '').trim();
    const artistName = String(form.get('artistName') ?? '').trim();
    const email = String(form.get('email') ?? '').trim();
    if (!title || !artistName || !email) throw new ValidationError('Title, artist and email are required');
    const audio = form.get('audio');
    const links = String(form.get('links') ?? '').split(/[\s,]+/).filter((l) => /^https?:\/\//.test(l)).slice(0, 5);
    if (!(audio instanceof File && audio.size > 0) && links.length === 0) throw new ValidationError('Attach an audio file or include a link');
    const demo = await withSystemOrg(
      org.id,
      async (ctx) => {
        let audioFileId: string | null = null;
        if (audio instanceof File && audio.size > 0) {
          const folder = await ensureSystemFolder(ctx, 'Demos');
          audioFileId = (await storeFile(ctx, { name: audio.name, mime: audio.type, body: audio.stream(), folderId: folder.id, kind: 'audio' })).id;
        }
        return createDemo(ctx, { title, artistName, submitterName: String(form.get('name') ?? '') || null, submitterEmail: email, links, genre: String(form.get('genre') ?? '') || null, notes: String(form.get('notes') ?? '').slice(0, 2000) || null, audioFileId }, 'intake');
      },
      'public intake',
    );
    return json({ ok: true, id: demo.id }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
