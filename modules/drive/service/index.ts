import '../types';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { and, asc, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { ServiceContext } from '@labelconsole/core/context';
import { memberships } from '@labelconsole/core/db/schema';
import { ForbiddenError, NotFoundError, ValidationError } from '@labelconsole/core/errors';
import { enqueueAfterCommit } from '@labelconsole/core/queue';
import { storage, storageKey, UPLOAD_RULES } from '@labelconsole/core/storage';
import { fileLinks, files, folderPermissions, folders, type DriveFile, type DriveFolder } from '../schema';

export type Access = 'none' | 'view' | 'edit' | 'manage';
const RANK: Record<Access, number> = { none: 0, view: 1, edit: 2, manage: 3 };

/* -------------------------------------------------------- permissions -- */

function moduleAccess(ctx: ServiceContext): Access {
  return ctx.can('drive:manage') ? 'manage' : ctx.can('drive:write') ? 'edit' : ctx.can('drive:read') ? 'view' : 'none';
}

async function actorRole(ctx: ServiceContext) {
  if (ctx.actor.type !== 'user') return null;
  const [m] = await ctx.tx.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.userId, ctx.actor.id), eq(memberships.orgId, ctx.orgId)));
  return m?.role ?? null;
}

const pathIds = (f: Pick<DriveFolder, 'id' | 'path'>) => [...f.path.split('/').filter(Boolean), f.id];

/**
 * Effective access to a folder. The deepest folder on the path with explicit
 * grants decides; without grants, the drive module permission applies.
 * drive:manage always has full access.
 */
export async function folderAccess(ctx: ServiceContext, folder: DriveFolder | null): Promise<Access> {
  const base = moduleAccess(ctx);
  if (!folder || base === 'manage' || base === 'none') return base;
  const ids = pathIds(folder);
  const grants = await ctx.tx.select().from(folderPermissions).where(inArray(folderPermissions.folderId, ids));
  if (grants.length === 0) return base;
  const deepest = [...ids].reverse().find((id) => grants.some((g) => g.folderId === id))!;
  const role = await actorRole(ctx);
  const mine = grants.filter((g) => g.folderId === deepest && ((g.principalType === 'user' && ctx.actor.type === 'user' && g.principal === ctx.actor.id) || (g.principalType === 'role' && g.principal === role)));
  const best = mine.reduce<Access>((acc, g) => (RANK[g.access as Access] > RANK[acc] ? (g.access as Access) : acc), 'none');
  return RANK[best] > RANK.edit ? 'edit' : best;
}

async function requireFolderAccess(ctx: ServiceContext, folder: DriveFolder | null, need: Access) {
  const have = await folderAccess(ctx, folder);
  if (RANK[have] < RANK[need]) throw new ForbiddenError(folder ? `You need ${need} access to "${folder.name}"` : `You need ${need} access to Drive`);
  return have;
}

/* ------------------------------------------------------------ folders -- */

export async function getFolder(ctx: ServiceContext, id: string) {
  const [f] = await ctx.tx.select().from(folders).where(eq(folders.id, id));
  if (!f) throw new NotFoundError('Folder');
  return f;
}

export async function breadcrumb(ctx: ServiceContext, folder: DriveFolder | null) {
  if (!folder) return [];
  const ids = pathIds(folder);
  const rows = await ctx.tx.select({ id: folders.id, name: folders.name }).from(folders).where(inArray(folders.id, ids));
  return ids.map((id) => rows.find((r) => r.id === id)!).filter(Boolean);
}

const canSeeConfidential = (ctx: ServiceContext) => ctx.can('documents:read_confidential') || ctx.can('drive:manage');

export async function listFolder(ctx: ServiceContext, folderId: string | null, opts: { q?: string } = {}) {
  ctx.assert('drive:read');
  const folder = folderId ? await getFolder(ctx, folderId) : null;
  const access = await requireFolderAccess(ctx, folder, 'view');
  const fileConds = [isNull(files.deletedAt)];
  if (opts.q) fileConds.push(ilike(files.name, `%${opts.q}%`));
  else fileConds.push(folderId ? eq(files.folderId, folderId) : isNull(files.folderId));
  if (!canSeeConfidential(ctx)) fileConds.push(eq(files.confidential, false));
  const [subfolders, fileRows] = await Promise.all([
    opts.q ? Promise.resolve([] as DriveFolder[]) : ctx.tx.select().from(folders).where(folderId ? eq(folders.parentId, folderId) : isNull(folders.parentId)).orderBy(asc(folders.name)),
    ctx.tx.select().from(files).where(and(...fileConds)).orderBy(desc(files.createdAt)).limit(500),
  ]);
  // Hide subfolders the reader cannot open.
  const visible: DriveFolder[] = [];
  for (const f of subfolders) if (RANK[await folderAccess(ctx, f)] >= RANK.view) visible.push(f);
  return { folder, access, folders: visible, files: fileRows, breadcrumb: await breadcrumb(ctx, folder) };
}

export const FolderInput = z.object({ name: z.string().trim().min(1).max(200).refine((n) => !/[\\/]/.test(n), 'Folder names cannot contain slashes'), parentId: z.uuid().nullable().optional() });

export async function createFolder(ctx: ServiceContext, input: z.infer<typeof FolderInput>) {
  ctx.assert('drive:write');
  const parent = input.parentId ? await getFolder(ctx, input.parentId) : null;
  await requireFolderAccess(ctx, parent, 'edit');
  const [row] = await ctx.tx
    .insert(folders)
    .values({ name: input.name, parentId: parent?.id ?? null, path: parent ? `${parent.path}${parent.id}/` : '/' })
    .returning();
  await ctx.audit({ action: 'folder.created', module: 'drive', targetType: 'folder', targetId: row.id, targetLabel: row.name });
  return row;
}

/** Find or create a top-level folder by name (Documents, Demos, Artwork...). */
export async function ensureSystemFolder(ctx: ServiceContext, name: string) {
  const [existing] = await ctx.tx.select().from(folders).where(and(isNull(folders.parentId), eq(folders.name, name)));
  if (existing) return existing;
  const [row] = await ctx.tx.insert(folders).values({ name, path: '/' }).returning();
  return row;
}

export async function renameFolder(ctx: ServiceContext, id: string, name: string) {
  const f = await getFolder(ctx, id);
  await requireFolderAccess(ctx, f, 'edit');
  const [row] = await ctx.tx.update(folders).set({ name }).where(eq(folders.id, id)).returning();
  await ctx.audit({ action: 'folder.renamed', module: 'drive', targetType: 'folder', targetId: id, targetLabel: name, before: { name: f.name }, after: { name } });
  return row;
}

export async function deleteFolder(ctx: ServiceContext, id: string) {
  ctx.assert('drive:delete');
  const f = await getFolder(ctx, id);
  await requireFolderAccess(ctx, f, 'edit');
  const subtree = await ctx.tx.select({ id: folders.id }).from(folders).where(or(eq(folders.id, id), ilike(folders.path, `%/${id}/%`)));
  const doomed = await ctx.tx.select().from(files).where(and(inArray(files.folderId, subtree.map((s) => s.id)), isNull(files.deletedAt)));
  if (doomed.length) await ctx.tx.update(files).set({ deletedAt: new Date(), status: 'deleted' }).where(inArray(files.id, doomed.map((d) => d.id)));
  await ctx.tx.delete(folders).where(eq(folders.id, id));
  ctx.afterCommit(async () => {
    for (const d of doomed) await storage().delete(d.storageKey).catch(() => undefined);
  });
  await ctx.audit({ action: 'folder.deleted', module: 'drive', targetType: 'folder', targetId: id, targetLabel: f.name, before: { files: doomed.length } });
}

/* -------------------------------------------------------------- files -- */

const SIGNATURES: Array<{ mime: RegExp; test: (b: Buffer) => boolean }> = [
  { mime: /^application\/pdf$/, test: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
  { mime: /^image\/png$/, test: (b) => b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG' },
  { mime: /^image\/jpeg$/, test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { mime: /^audio\/(mpeg|mp3)$/, test: (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { mime: /^audio\/(x-)?(wav|wave)$/, test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE' },
  { mime: /^audio\/(x-)?flac$/, test: (b) => b.subarray(0, 4).toString('latin1') === 'fLaC' },
  { mime: /officedocument|^application\/zip$/, test: (b) => b[0] === 0x50 && b[1] === 0x4b },
];

/** Reject files whose bytes contradict their declared type (e.g. an .exe renamed to .pdf). */
export function sniffMismatch(mime: string, head: Buffer) {
  const rule = SIGNATURES.find((s) => s.mime.test(mime));
  return rule ? !rule.test(head) : false;
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff', m4a: 'audio/mp4', ogg: 'audio/ogg',
  csv: 'text/csv', txt: 'text/plain', json: 'application/json', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeFor(name: string, declared?: string | null) {
  if (declared && declared !== 'application/octet-stream') return declared;
  return EXT_MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export type StoreInput = {
  name: string;
  mime?: string | null;
  body: Buffer | Readable | ReadableStream<Uint8Array>;
  folderId?: string | null;
  confidential?: boolean;
  kind?: keyof typeof UPLOAD_RULES;
  external?: { provider: string; id: string };
};

/**
 * The single way files enter storage. Streams the body to object storage
 * while hashing and counting bytes, enforces type and size rules, sniffs the
 * first bytes, records the file and queues a virus scan.
 */
export async function storeFile(ctx: ServiceContext, input: StoreInput): Promise<DriveFile> {
  ctx.assert('drive:write');
  const folder = input.folderId ? await getFolder(ctx, input.folderId) : null;
  await requireFolderAccess(ctx, folder, 'edit');
  const name = input.name.replace(/[\u0000-\u001f]/g, '').slice(0, 250) || 'untitled';
  const mime = mimeFor(name, input.mime);
  const rule = UPLOAD_RULES[input.kind ?? 'any'];
  if (!rule.mimes.test(mime)) throw new ValidationError(`Files of type ${mime} are not allowed here`);

  const source = Buffer.isBuffer(input.body) ? Readable.from(input.body) : input.body instanceof Readable ? input.body : Readable.fromWeb(input.body as never);
  const hash = createHash('sha256');
  let size = 0;
  let head: Buffer | null = null;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!head) {
        head = chunk.subarray(0, 16);
        if (sniffMismatch(mime, head)) return cb(new ValidationError(`The file content does not look like ${mime}`));
      }
      size += chunk.length;
      if (size > rule.maxBytes) return cb(new ValidationError(`File is larger than ${Math.round(rule.maxBytes / 1024 / 1024)} MB`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const key = storageKey(ctx.orgId, 'drive', name);
  try {
    await storage().put(key, source.pipe(meter), { contentType: mime });
  } catch (err) {
    await storage().delete(key).catch(() => undefined);
    throw err instanceof ValidationError ? err : new ValidationError((err as Error).message);
  }
  if (size === 0) {
    await storage().delete(key).catch(() => undefined);
    throw new ValidationError('The file is empty');
  }
  const [row] = await ctx.tx
    .insert(files)
    .values({ name, storageKey: key, size, mime, checksum: hash.digest('hex'), folderId: folder?.id ?? null, confidential: input.confidential ?? false, externalProvider: input.external?.provider, externalId: input.external?.id })
    .returning();
  await ctx.audit({ action: 'file.uploaded', module: 'drive', targetType: 'file', targetId: row.id, targetLabel: name, after: { size, mime, folder: folder?.name ?? null } });
  await ctx.emit('drive.file.uploaded', { fileId: row.id, name, mime, folderId: row.folderId });
  enqueueAfterCommit(ctx, 'drive.scan-file', { fileId: row.id }, { jobId: `scan-${row.id}` });
  return row;
}

export async function getFile(ctx: ServiceContext, id: string) {
  ctx.assert('drive:read');
  const [f] = await ctx.tx.select().from(files).where(and(eq(files.id, id), isNull(files.deletedAt)));
  if (!f) throw new NotFoundError('File');
  if (f.confidential && !canSeeConfidential(ctx)) throw new ForbiddenError('This file is confidential');
  await requireFolderAccess(ctx, f.folderId ? await getFolder(ctx, f.folderId) : null, 'view');
  return f;
}

export async function getFilesByIds(ctx: ServiceContext, ids: string[]) {
  if (ids.length === 0) return [];
  return ctx.tx.select().from(files).where(and(inArray(files.id, ids), isNull(files.deletedAt)));
}

/** Short-lived download link. Confidential files get 60 seconds and an audit entry. */
export async function downloadUrl(ctx: ServiceContext, id: string, opts: { inline?: boolean } = {}) {
  const f = await getFile(ctx, id);
  if (f.status === 'quarantined') throw new ForbiddenError('This file failed the virus scan and cannot be downloaded');
  if (f.confidential) await ctx.audit({ action: 'file.downloaded', module: 'drive', targetType: 'file', targetId: f.id, targetLabel: f.name });
  return storage().signedUrl(f.storageKey, { expiresInSec: f.confidential ? 60 : 300, filename: f.name, inline: opts.inline });
}

export async function readFileBuffer(ctx: ServiceContext, id: string, maxBytes = 25 * 1024 * 1024) {
  const f = await getFile(ctx, id);
  if (f.status === 'quarantined') throw new ForbiddenError('This file failed the virus scan');
  if (f.size > maxBytes) throw new ValidationError(`File is too large to read (${f.size} bytes)`);
  const stream = await storage().get(f.storageKey);
  return { file: f, body: Buffer.concat(await stream.toArray()) };
}

/** First bytes of a file, e.g. to read embedded audio tags without downloading the whole thing. */
export async function readFileHead(ctx: ServiceContext, id: string, bytes = 4 * 1024 * 1024) {
  const f = await getFile(ctx, id);
  const stream = await storage().get(f.storageKey);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    total += (chunk as Buffer).length;
    if (total >= bytes) break;
  }
  stream.destroy();
  return { file: f, head: Buffer.concat(chunks).subarray(0, bytes) };
}

export const FilePatch = z.object({ name: z.string().trim().min(1).max(250), folderId: z.uuid().nullable(), confidential: z.boolean() }).partial();

export async function updateFile(ctx: ServiceContext, id: string, patch: z.infer<typeof FilePatch>) {
  ctx.assert('drive:write');
  const before = await getFile(ctx, id);
  await requireFolderAccess(ctx, before.folderId ? await getFolder(ctx, before.folderId) : null, 'edit');
  if (patch.folderId !== undefined) await requireFolderAccess(ctx, patch.folderId ? await getFolder(ctx, patch.folderId) : null, 'edit');
  if (patch.confidential !== undefined && !canSeeConfidential(ctx)) throw new ForbiddenError('Only people who can open confidential files can change the flag');
  const [after] = await ctx.tx.update(files).set(patch).where(eq(files.id, id)).returning();
  await ctx.audit({ action: 'file.updated', module: 'drive', targetType: 'file', targetId: id, targetLabel: after.name, before: before as never, after: after as never });
  return after;
}

export async function deleteFile(ctx: ServiceContext, id: string) {
  ctx.assert('drive:delete');
  const f = await getFile(ctx, id);
  await requireFolderAccess(ctx, f.folderId ? await getFolder(ctx, f.folderId) : null, 'edit');
  await ctx.tx.update(files).set({ deletedAt: new Date(), status: 'deleted' }).where(eq(files.id, id));
  ctx.afterCommit(() => storage().delete(f.storageKey));
  await ctx.audit({ action: 'file.deleted', module: 'drive', targetType: 'file', targetId: id, targetLabel: f.name });
}

/* -------------------------------------------------------------- links -- */

export async function linkFile(ctx: ServiceContext, fileId: string, entityType: string, entityId: string) {
  await getFile(ctx, fileId);
  await ctx.tx.insert(fileLinks).values({ fileId, entityType, entityId }).onConflictDoNothing();
}

export async function unlinkFile(ctx: ServiceContext, fileId: string, entityType: string, entityId: string) {
  ctx.assert('drive:write');
  await ctx.tx.delete(fileLinks).where(and(eq(fileLinks.fileId, fileId), eq(fileLinks.entityType, entityType), eq(fileLinks.entityId, entityId)));
}

export async function filesFor(ctx: ServiceContext, entityType: string, entityId: string) {
  ctx.assert('drive:read');
  const conds = [eq(fileLinks.entityType, entityType), eq(fileLinks.entityId, entityId), isNull(files.deletedAt)];
  if (!canSeeConfidential(ctx)) conds.push(eq(files.confidential, false));
  return ctx.tx.select({ file: files }).from(fileLinks).innerJoin(files, eq(files.id, fileLinks.fileId)).where(and(...conds)).orderBy(desc(files.createdAt));
}

/* --------------------------------------------------- folder permissions -- */

export const GrantInput = z.object({ principalType: z.enum(['role', 'user']), principal: z.string().min(1), access: z.enum(['view', 'edit', 'manage']) });

export async function listGrants(ctx: ServiceContext, folderId: string) {
  ctx.assert('drive:read');
  return ctx.tx.select().from(folderPermissions).where(eq(folderPermissions.folderId, folderId));
}

export async function setGrant(ctx: ServiceContext, folderId: string, input: z.infer<typeof GrantInput>) {
  ctx.assert('drive:manage');
  const folder = await getFolder(ctx, folderId);
  const [row] = await ctx.tx
    .insert(folderPermissions)
    .values({ folderId, ...input })
    .onConflictDoUpdate({ target: [folderPermissions.folderId, folderPermissions.principalType, folderPermissions.principal], set: { access: input.access } })
    .returning();
  await ctx.audit({ action: 'folder.permission_set', module: 'drive', targetType: 'folder', targetId: folderId, targetLabel: folder.name, after: input });
  return row;
}

export async function removeGrant(ctx: ServiceContext, grantId: string) {
  ctx.assert('drive:manage');
  const [row] = await ctx.tx.delete(folderPermissions).where(eq(folderPermissions.id, grantId)).returning();
  if (row) await ctx.audit({ action: 'folder.permission_removed', module: 'drive', targetType: 'folder', targetId: row.folderId, before: { principal: row.principal, access: row.access } });
}

/* ------------------------------------------------- Google Drive mirror -- */

export const ConnectInput = z.object({ name: z.string().trim().min(1).max(200), externalId: z.string().trim().min(5).max(200), parentId: z.uuid().nullable().optional() });

/** Create a local folder that mirrors a Google Drive folder (pull only). */
export async function connectGoogleFolder(ctx: ServiceContext, input: z.infer<typeof ConnectInput>) {
  ctx.assert('drive:manage');
  const id = input.externalId.match(/folders\/([A-Za-z0-9_-]+)/)?.[1] ?? input.externalId;
  const folder = await createFolder(ctx, { name: input.name, parentId: input.parentId ?? null });
  const [row] = await ctx.tx.update(folders).set({ externalProvider: 'google_drive', externalId: id, syncMode: 'mirror' }).where(eq(folders.id, folder.id)).returning();
  enqueueAfterCommit(ctx, 'drive.sync-folder', { folderId: row.id }, { jobId: `sync-${row.id}-${Date.now()}` });
  return row;
}

export async function requestSync(ctx: ServiceContext, folderId: string) {
  ctx.assert('drive:manage');
  const f = await getFolder(ctx, folderId);
  if (f.externalProvider !== 'google_drive') throw new ValidationError('This folder is not connected to Google Drive');
  enqueueAfterCommit(ctx, 'drive.sync-folder', { folderId }, { jobId: `sync-${folderId}-${Date.now()}` });
  return { queued: true };
}

export async function storageUsage(ctx: ServiceContext) {
  const rows = await ctx.tx.select({ size: files.size }).from(files).where(isNull(files.deletedAt));
  return { files: rows.length, bytes: rows.reduce((n, r) => n + r.size, 0) };
}
