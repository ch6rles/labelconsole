import { fetchBinary, fetchJson } from '@labelconsole/core/http';
import { ProviderError } from '@labelconsole/core/errors';

/** Minimal Google Drive v3 client for read-only mirroring (drive.readonly scope). */
export type GoogleSecret = { clientId: string; clientSecret: string; refreshToken: string };
export type DriveItem = { id: string; name: string; mimeType: string; size?: string; modifiedTime: string; md5Checksum?: string };

const RL = { key: 'google-drive', capacity: 10, refillPerSec: 10 };

export async function accessToken(secret: GoogleSecret): Promise<string> {
  const body = new URLSearchParams({ client_id: secret.clientId, client_secret: secret.clientSecret, refresh_token: secret.refreshToken, grant_type: 'refresh_token' });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !json.access_token) throw new ProviderError('google_drive', json.error_description ?? json.error ?? `token exchange failed (${res.status})`, { status: res.status, transient: res.status >= 500 });
  return json.access_token;
}

export async function listChildren(token: string, folderId: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      q: `'${folderId.replace(/'/g, '')}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, md5Checksum)',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    });
    const page = await fetchJson<{ files: DriveItem[]; nextPageToken?: string }>(`https://www.googleapis.com/drive/v3/files?${q}`, { provider: 'google_drive', headers: { authorization: `Bearer ${token}` }, rateLimit: RL });
    out.push(...(page?.files ?? []));
    pageToken = page?.nextPageToken;
  } while (pageToken);
  return out;
}

export const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: 'csv' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
};

/** Download a file; Google-native documents are exported (Docs and Slides to PDF, Sheets to CSV). */
export async function download(token: string, item: DriveItem, maxBytes: number) {
  const exp = EXPORTS[item.mimeType];
  if (item.mimeType.startsWith('application/vnd.google-apps.') && !exp) return null;
  const url = exp
    ? `https://www.googleapis.com/drive/v3/files/${item.id}/export?mimeType=${encodeURIComponent(exp.mime)}`
    : `https://www.googleapis.com/drive/v3/files/${item.id}?alt=media&supportsAllDrives=true`;
  const res = await fetchBinary(url, { provider: 'google_drive', headers: { authorization: `Bearer ${token}` }, maxBytes });
  return { body: res.body, mime: exp?.mime ?? item.mimeType, name: exp && !item.name.endsWith(`.${exp.ext}`) ? `${item.name}.${exp.ext}` : item.name };
}
