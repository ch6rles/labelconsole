import { z } from 'zod';
import { fetchPublicFile } from '@labelconsole/core/net';
import { extractText } from '@labelconsole/core/text';
import { clip, compact, defineTool } from '@labelconsole/core/tools';
import * as svc from '../service';

const SAVE_EXT: Record<string, string> = { 'text/plain': '.txt', 'text/csv': '.csv', 'text/markdown': '.md', 'application/json': '.json' };

export const tools = [
  defineTool({
    name: 'drive_list_files',
    module: 'drive',
    description: 'List folders and files in the label Drive. Give a folderId to look inside a folder, or q to search file names across Drive.',
    input: z.object({ folderId: z.uuid().optional(), q: z.string().max(100).optional() }),
    permission: 'drive:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const r = await svc.listFolder(ctx, i.folderId ?? null, { q: i.q });
        return {
          path: r.breadcrumb.map((b) => b.name).join(' / ') || 'Drive',
          folders: r.folders.map((f) => ({ id: f.id, name: f.name })),
          files: r.files.slice(0, 100).map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, uploadedAt: f.createdAt })),
        };
      }),
  }),
  defineTool({
    name: 'drive_read_file',
    module: 'drive',
    description: 'Read the text of a file in Drive (PDF, text, CSV, JSON). Other types return metadata only. Long files are truncated.',
    input: z.object({ fileId: z.uuid() }),
    permission: 'drive:read',
    risk: 'read',
    idempotent: true,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        const { file, body } = await svc.readFileBuffer(ctx, i.fileId);
        const text = await extractText(body, file.mime);
        return compact({ id: file.id, name: file.name, mime: file.mime, size: file.size, text: text ? clip(text.text, 20_000) : null, truncated: Boolean(text && text.text.length > 20_000) });
      }),
  }),
  defineTool({
    name: 'drive_save_file',
    module: 'drive',
    description: 'Save text you wrote (a brief, a report, a pitch list as CSV) as a new file in Drive.',
    input: z.object({ name: z.string().min(1).max(200), content: z.string().max(500_000), folderId: z.uuid().optional(), mime: z.enum(['text/plain', 'text/csv', 'text/markdown', 'application/json']).default('text/plain') }),
    permission: 'drive:write',
    risk: 'write',
    preview: (i) => `Save "${i.name}" (${i.content.length} characters) to Drive`,
    execute: (t, i) =>
      t.withOrg(async (ctx) => {
        // Give the file the extension its type implies, so Drive opens Markdown rendered, CSV as a sheet, and so on.
        const ext = SAVE_EXT[i.mime];
        const name = /\.(md|markdown|txt|csv|tsv|json)$/i.test(i.name) ? i.name : `${i.name}${ext}`;
        const row = await svc.storeFile(ctx, { name, mime: i.mime === 'text/markdown' ? 'text/plain' : i.mime, body: Buffer.from(i.content, 'utf8'), folderId: i.folderId ?? null });
        return { id: row.id, name: row.name, size: row.size, href: `/drive/files/${row.id}` };
      }),
  }),
  defineTool({
    name: 'drive_save_images',
    module: 'drive',
    description:
      'Download images from public https links (profile pictures, post thumbnails, artwork found during research) and save them in a Drive folder, given as a path like "Research/Funk editors". Missing folders are created. Up to 20 images per call; each must be a PNG, JPEG, WebP or GIF under 15 MB. Links from scraped results expire within hours, so save them in the same run.',
    input: z.object({
      folder: z.string().trim().min(1).max(500).describe('Folder path, e.g. "Research/Funk editors"'),
      images: z
        .array(z.object({ url: z.url().max(4000), name: z.string().trim().max(120).optional().describe('File name without extension, e.g. "editx_funk-avatar"') }))
        .min(1)
        .max(20),
    }),
    permission: 'drive:write',
    risk: 'write',
    timeoutMs: 180_000,
    preview: (i) => `Save ${i.images.length} image${i.images.length === 1 ? '' : 's'} to Drive / ${i.folder}`,
    execute: async (t, i) => {
      const folder = await t.withOrg((ctx) => svc.ensureFolderPath(ctx, i.folder));
      const saved: Array<{ id: string; name: string; size: number }> = [];
      const failed: Array<{ url: string; error: string }> = [];
      // A few at a time: fast enough for 20 images without hammering one CDN.
      const queue = i.images.map((img, n) => ({ ...img, n }));
      const worker = async () => {
        for (let img = queue.shift(); img; img = queue.shift()) {
          try {
            const file = await fetchPublicFile(img.url, { accept: IMAGE_TYPES, maxBytes: 15 * 1024 * 1024, timeoutMs: 20_000, signal: t.signal });
            const name = `${imageName(img.name, img.url, img.n)}.${IMAGE_EXT[file.contentType] ?? 'jpg'}`;
            const row = await t.withOrg((ctx) => svc.storeFile(ctx, { name, mime: file.contentType, body: file.body, folderId: folder.id, kind: 'image' }));
            saved.push({ id: row.id, name: row.name, size: row.size });
          } catch (err) {
            failed.push({ url: clip(img.url, 200), error: (err as Error).message });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
      return { folder: i.folder, folderId: folder.id, saved, ...(failed.length ? { failed } : {}) };
    },
  }),
];

const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** A safe file name: the one given, else the link's last path segment, else a number. */
function imageName(given: string | undefined, url: string, n: number) {
  const fromUrl = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').replace(/\.[a-z0-9]{2,5}$/i, '');
    } catch {
      return '';
    }
  })();
  const clean = clip((given || fromUrl).replace(/[^\p{L}\p{N} ._-]+/gu, '-'), 80).replace(/^[-. ]+|[-. ]+$/g, '');
  return clean || `image-${n + 1}`;
}
