import { z } from 'zod';
import { extractText } from '@labelconsole/core/text';
import { compact, defineTool } from '@labelconsole/core/tools';
import * as svc from '../service';

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
        return compact({ id: file.id, name: file.name, mime: file.mime, size: file.size, text: text ? text.text.slice(0, 20_000) : null, truncated: Boolean(text && text.text.length > 20_000) });
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
        const row = await svc.storeFile(ctx, { name: i.name, mime: i.mime === 'text/markdown' ? 'text/plain' : i.mime, body: Buffer.from(i.content, 'utf8'), folderId: i.folderId ?? null });
        return { id: row.id, name: row.name, size: row.size };
      }),
  }),
];
