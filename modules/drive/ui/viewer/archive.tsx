'use client';

import { useMemo, useState } from 'react';
import { Icon, fmt } from '@labelconsole/ui';
import { KIND_ICON, fileKind } from '../../kinds';
import type { ArchiveEntry } from '../../preview';
import { Spacer, Toolbar, type ViewerProps } from './shared';

type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: ArchiveEntry[]; size: number; packed: number; count: number; modified: string | null };
type SortKey = 'name' | 'size' | 'modified';

function buildTree(entries: ArchiveEntry[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [], size: 0, packed: 0, count: 0, modified: null };
  for (const e of entries) {
    const parts = e.name.replace(/\/+$/, '').split('/').filter(Boolean);
    if (!parts.length) continue;
    let dir = root;
    const trail: Dir[] = [root];
    for (const [k, part] of parts.slice(0, e.directory ? parts.length : -1).entries()) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { name: part, path: parts.slice(0, k + 1).join('/'), dirs: new Map(), files: [], size: 0, packed: 0, count: 0, modified: null };
        dir.dirs.set(part, next);
      }
      dir = next;
      trail.push(dir);
    }
    if (e.directory) {
      dir.modified ??= e.modified;
      continue;
    }
    dir.files.push({ ...e, name: parts.at(-1)! });
    for (const d of trail) {
      d.size += e.size;
      d.packed += e.compressedSize;
      d.count += 1;
      if (e.modified && (!d.modified || e.modified > d.modified)) d.modified = e.modified;
    }
  }
  return root;
}

const ratio = (size: number, packed: number) => (size > 0 ? `${Math.max(0, Math.round((1 - packed / size) * 100))}%` : '–');

/**
 * Zip archives: browse the folders inside, sorted by name, size or date, with
 * how much each file was compressed; search every path at once; totals.
 */
export function ArchiveViewer({ file, entries, total, totalSize }: ViewerProps & { entries: ArchiveEntry[]; total: number; totalSize: number }) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [path, setPath] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });

  let here = tree;
  for (const p of path) here = here.dirs.get(p) ?? here;

  const folders = useMemo(() => [...here.dirs.values()], [here]);
  const files = here.files;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? entries.filter((e) => !e.directory && e.name.toLowerCase().includes(q)) : null;
  }, [entries, query]);

  const by = <T extends { name: string; size: number; modified: string | null }>(list: T[]) =>
    [...list].sort((a, b) => {
      const d = sort.key === 'size' ? a.size - b.size : sort.key === 'modified' ? (a.modified ?? '').localeCompare(b.modified ?? '') : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      return d * sort.dir;
    });
  const head = (key: SortKey, label: string, align?: 'right') => (
    <th style={{ textAlign: align }} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 }))}>
        {label}
        {sort.key === key && <Icon name={sort.dir === 1 ? 'arrow_upward' : 'arrow_downward'} size={14} />}
      </button>
    </th>
  );
  const folderCount = useMemo(() => {
    let n = 0;
    const walk = (d: Dir) => d.dirs.forEach((c) => (n++, walk(c)));
    walk(tree);
    return n;
  }, [tree]);

  return (
    <div className="lc-fv lc-fv-archive">
      <Toolbar>
        <nav className="lc-fv-crumbs" aria-label="Folder in archive">
          <button type="button" onClick={() => setPath([])} disabled={!path.length && !matches}>
            <Icon name="folder_zip" size={16} />
            {file.name}
          </button>
          {!matches &&
            path.map((p, k) => (
              <span key={k}>
                <Icon name="chevron_right" size={14} />
                <button type="button" onClick={() => setPath(path.slice(0, k + 1))} disabled={k === path.length - 1}>
                  {p}
                </button>
              </span>
            ))}
        </nav>
        <Spacer />
        <span className="lc-fv-find">
          <Icon name="search" size={16} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search in archive" aria-label="Search in archive" />
          {matches && <span className="lc-fv-find-count">{matches.length.toLocaleString()}</span>}
        </span>
      </Toolbar>
      {total > entries.length && <div className="lc-fv-banner">Listing the first {entries.length.toLocaleString()} of {total.toLocaleString()} items.</div>}
      <div className="lc-fv-stage lc-fv-scroll">
        <table className="lc-fv-files">
          <thead>
            <tr>
              {head('name', 'Name')}
              {head('size', 'Size', 'right')}
              <th style={{ textAlign: 'right' }}>Saved</th>
              {head('modified', 'Modified', 'right')}
            </tr>
          </thead>
          <tbody>
            {matches ? (
              by(matches).map((e) => <FileRow key={e.name} entry={e} label={e.name} />)
            ) : (
              <>
                {path.length > 0 && (
                  <tr className="is-folder" onClick={() => setPath(path.slice(0, -1))}>
                    <td colSpan={4}>
                      <span className="lc-fv-file-name">
                        <Icon name="arrow_upward" size={18} />
                        Up one folder
                      </span>
                    </td>
                  </tr>
                )}
                {by(folders).map((d) => (
                  <tr key={d.path} className="is-folder" onClick={() => setPath([...path, d.name])} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setPath([...path, d.name])}>
                    <td>
                      <span className="lc-fv-file-name">
                        <Icon name="folder" size={18} />
                        {d.name}
                        <span className="lc-muted"> · {d.count.toLocaleString()} {d.count === 1 ? 'file' : 'files'}</span>
                      </span>
                    </td>
                    <td className="is-num">{fmt.bytes(d.size)}</td>
                    <td className="is-num lc-muted">{ratio(d.size, d.packed)}</td>
                    <td className="is-num lc-muted">{d.modified ? fmt.shortDate(d.modified) : ''}</td>
                  </tr>
                ))}
                {by(files).map((e) => (
                  <FileRow key={e.name} entry={e} label={e.name} />
                ))}
              </>
            )}
          </tbody>
        </table>
        {((matches && !matches.length) || (!matches && !folders.length && !files.length)) && <div className="lc-fv-empty">{matches ? 'Nothing in the archive matches that' : 'This folder is empty'}</div>}
      </div>
      <div className="lc-fv-status">
        <span>
          {tree.count.toLocaleString()} files · {folderCount.toLocaleString()} folders
        </span>
        <span>{fmt.bytes(totalSize)} unpacked</span>
        <span>
          {fmt.bytes(file.size)} as a zip ({ratio(totalSize, file.size)} smaller)
        </span>
      </div>
    </div>
  );
}

function FileRow({ entry, label }: { entry: ArchiveEntry; label: string }) {
  return (
    <tr>
      <td>
        <span className="lc-fv-file-name" title={label}>
          <Icon name={KIND_ICON[fileKind(label, null)]} size={18} />
          <span className="lc-ellipsis">{label}</span>
        </span>
      </td>
      <td className="is-num">{fmt.bytes(entry.size)}</td>
      <td className="is-num lc-muted">{ratio(entry.size, entry.compressedSize)}</td>
      <td className="is-num lc-muted">{entry.modified ? fmt.shortDate(entry.modified) : ''}</td>
    </tr>
  );
}
