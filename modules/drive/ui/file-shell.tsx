'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Chip, Icon, fmt } from '@labelconsole/ui';
import { ActionButton, ApiToggle, FormModal, useToast } from '@labelconsole/ui/client';
import { KIND_ICON, KIND_LABEL } from '../kinds';
import { FileViewer, type ViewerFile } from './viewer';
import { downloadHref } from './viewer/shared';

type Sibling = { id: string; name: string } | null;

const SHORTCUTS: Array<[string, string]> = [
  ['← →', 'Previous / next file (when the viewer isn’t using them)'],
  ['Esc', 'Back to the folder'],
  ['I', 'Show or hide details'],
  ['Ctrl F or /', 'Find in the file'],
  ['+ − 0', 'Zoom in, out, fit'],
  ['Space', 'Play / pause audio and video'],
];

/**
 * The file page around the viewer: where the file lives, previous and next in
 * its folder, download / open / copy link / rename / move / delete, and a
 * details panel (type, size, upload date, checksum, virus scan, linked records).
 */
export function FileShell({ file, details, crumbs, folderHref, nav, links, folders, can }: {
  file: ViewerFile;
  details: { createdAt: string; checksum: string | null; scanStatus: string; quarantined: boolean; confidential: boolean; source: string | null };
  crumbs: Array<{ id: string; name: string }>;
  folderHref: string;
  nav: { previous: Sibling; next: Sibling; position: number; count: number };
  links: Array<{ id: string; label: string; icon: string; href: string | null }>;
  folders: Array<{ value: string; label: string }>;
  can: { edit: boolean; delete: boolean; confidential: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [info, setInfo] = useState(false);
  useEffect(() => {
    // The details panel starts open on wide screens.
    setInfo(window.innerWidth >= 1600);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"]') || document.fullscreenElement) return;
      if (e.key === 'ArrowLeft' && nav.previous) router.push(`/drive/files/${nav.previous.id}`);
      else if (e.key === 'ArrowRight' && nav.next) router.push(`/drive/files/${nav.next.id}`);
      else if (e.key === 'Escape') router.push(folderHref);
      else if (e.key === 'i') setInfo((v) => !v);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, folderHref, router]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/drive/files/${file.id}`);
      toast('Link copied');
    } catch {
      toast('Couldn’t copy the link', 'error');
    }
  };

  return (
    <div className="lc-fv-page">
      <div className="lc-fv-page-head">
        <nav className="lc-crumb lc-fv-page-crumb" aria-label="Folder path">
          <Link href="/drive">Drive</Link>
          {crumbs.map((c) => (
            <span key={c.id} style={{ display: 'contents' }}>
              <Icon name="chevron_right" size={14} />
              <Link href={`/drive?folder=${c.id}`}>{c.name}</Link>
            </span>
          ))}
        </nav>
        <div className="lc-fv-page-row">
          <Link href={folderHref} className="lc-fv-tool" title="Back to the folder (Esc)" aria-label="Back to the folder">
            <Icon name="arrow_back" size={18} />
          </Link>
          <span className="lc-fv-page-icon">
            <Icon name={KIND_ICON[file.kind]} size={20} />
          </span>
          <div className="lc-fv-page-title">
            <h1 title={file.name}>{file.name}</h1>
            <span className="lc-fv-page-sub">
              {KIND_LABEL[file.kind]} · {fmt.bytes(file.size)} · {fmt.date(details.createdAt)}
              {details.confidential && (
                <>
                  {' · '}
                  <Icon name="lock" size={12} /> Confidential
                </>
              )}
            </span>
          </div>
          <div className="lc-fv-page-actions">
            {nav.count > 1 && (
              <span className="lc-fv-page-nav">
                {nav.previous ? (
                  <Link href={`/drive/files/${nav.previous.id}`} className="lc-fv-tool" title={`Previous: ${nav.previous.name} (←)`} aria-label="Previous file">
                    <Icon name="chevron_left" size={18} />
                  </Link>
                ) : (
                  <span className="lc-fv-tool" aria-disabled>
                    <Icon name="chevron_left" size={18} />
                  </span>
                )}
                <span className="lc-fv-meta">
                  {nav.position} of {nav.count}
                </span>
                {nav.next ? (
                  <Link href={`/drive/files/${nav.next.id}`} className="lc-fv-tool" title={`Next: ${nav.next.name} (→)`} aria-label="Next file">
                    <Icon name="chevron_right" size={18} />
                  </Link>
                ) : (
                  <span className="lc-fv-tool" aria-disabled>
                    <Icon name="chevron_right" size={18} />
                  </span>
                )}
              </span>
            )}
            {!details.quarantined && (
              <a className="lc-btn lc-btn--sm lc-btn--primary" href={downloadHref(file.id)}>
                <Icon name="download" />
                <span className="lc-fv-hide-sm">Download</span>
              </a>
            )}
            {!details.quarantined && (
              <a className="lc-btn lc-btn--sm lc-fv-hide-sm" href={`/api/v1/drive/files/${file.id}/download?inline=1`} target="_blank" rel="noopener noreferrer" title="Open the original file in a new tab">
                <Icon name="open_in_new" />
                Open original
              </a>
            )}
            <button type="button" className="lc-btn lc-btn--sm" onClick={copyLink} title="Copy a link to this file (people need Drive access to open it)">
              <Icon name="link" />
              <span className="lc-fv-hide-sm">Copy link</span>
            </button>
            {can.edit && (
              <FormModal
                title="Rename file"
                trigger={{ label: '', icon: 'edit', size: 'sm', title: 'Rename' }}
                endpoint={`/drive/files/${file.id}`}
                method="PATCH"
                initial={{ name: file.name }}
                fields={[{ name: 'name', label: 'Name', required: true, full: true }]}
                columns={1}
                success="Renamed"
              />
            )}
            {can.edit && (
              <FormModal
                title="Move file"
                description="Choose the folder to move it to."
                trigger={{ label: '', icon: 'drive_file_move', size: 'sm', title: 'Move' }}
                endpoint={`/drive/files/${file.id}`}
                method="PATCH"
                initial={{ folderId: crumbs.at(-1)?.id ?? '' }}
                fields={[{ name: 'folderId', label: 'Folder', type: 'select', options: [{ value: '', label: 'Drive (top level)' }, ...folders], full: true }]}
                columns={1}
                success="Moved"
              />
            )}
            {can.delete && <ActionButton endpoint={`/drive/files/${file.id}`} method="DELETE" label="" icon="delete" size="sm" title="Delete" confirm={`Delete ${file.name}?`} redirectTo={folderHref} success="Deleted" />}
            <button type="button" className={`lc-fv-tool${info ? ' is-active' : ''}`} onClick={() => setInfo(!info)} title="Details (I)" aria-label="Details" aria-pressed={info}>
              <Icon name="info" size={18} />
            </button>
          </div>
        </div>
      </div>
      <div className="lc-fv-page-body">
        <div className="lc-fv-page-viewer">
          {details.quarantined ? (
            <div className="lc-fv-notice">
              <Icon name="gpp_bad" size={32} />
              <strong>This file failed the virus scan</strong>
              <span>It’s quarantined and can’t be opened or downloaded.</span>
            </div>
          ) : (
            <FileViewer key={file.id} file={file} />
          )}
        </div>
        {info && (
          <aside className="lc-fv-info" aria-label="File details">
            <div className="lc-fv-props-head">
              <strong>Details</strong>
              <button type="button" className="lc-fv-tool" onClick={() => setInfo(false)} aria-label="Close details">
                <Icon name="close" size={18} />
              </button>
            </div>
            <dl>
              <div>
                <dt>Kind</dt>
                <dd>{KIND_LABEL[file.kind]}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd className="lc-mono">{file.mime || 'unknown'}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>
                  {fmt.bytes(file.size)} <span className="lc-muted">({file.size.toLocaleString()} bytes)</span>
                </dd>
              </div>
              <div>
                <dt>Added</dt>
                <dd>
                  {fmt.date(details.createdAt)} · {fmt.time(details.createdAt)}
                </dd>
              </div>
              <div>
                <dt>Folder</dt>
                <dd>{crumbs.length ? crumbs.map((c) => c.name).join(' / ') : 'Drive (top level)'}</dd>
              </div>
              {details.source && (
                <div>
                  <dt>Source</dt>
                  <dd>{details.source}</dd>
                </div>
              )}
              <div>
                <dt>Virus scan</dt>
                <dd>
                  <Chip tone={details.scanStatus === 'clean' ? 'blue' : details.scanStatus === 'infected' ? 'red' : 'neutral'}>{fmt.titleCase(details.scanStatus)}</Chip>
                </dd>
              </div>
              {details.checksum && (
                <div>
                  <dt>SHA-256</dt>
                  <dd className="lc-mono lc-fv-hash" title={details.checksum}>
                    {details.checksum}
                  </dd>
                </div>
              )}
              {can.confidential && (
                <div>
                  <dt>Confidential</dt>
                  <dd>
                    <ApiToggle endpoint={`/drive/files/${file.id}`} field="confidential" on={details.confidential} title="Only people who can see confidential files can open it" />
                  </dd>
                </div>
              )}
            </dl>
            <div className="lc-fv-side-title">Attached to</div>
            {links.length ? (
              <ul className="lc-fv-links">
                {links.map((l) => (
                  <li key={`${l.label}-${l.id}`}>
                    <Icon name={l.icon} size={16} />
                    {l.href ? <Link href={l.href}>{l.label} record</Link> : <span>{l.label}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="lc-muted">Not attached to any record.</p>
            )}
            <div className="lc-fv-side-title">Keyboard</div>
            <dl className="lc-fv-keys">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </aside>
        )}
      </div>
    </div>
  );
}
