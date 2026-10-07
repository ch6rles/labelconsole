import type { PanelProps } from '@labelconsole/core/web';
import { EmptyState, Icon, fmt } from '@labelconsole/ui';
import { UploadZone } from '@labelconsole/ui/client';
import Link from 'next/link';
import { KIND_ICON, fileKind } from '../kinds';
import * as svc from '../service';

/** "Files" panel that any record page can show, contributed by Drive. */
export function filesPanel(entityType: string) {
  return async function FilesPanel({ entityId, run, session }: PanelProps) {
    const rows = await run((ctx) => svc.filesFor(ctx, entityType, entityId));
    return (
      <div className="lc-stack">
        {session.permissions.has('drive:write') && <UploadZone endpoint="/drive/files" extra={{ entityType, entityId }} compact label="Attach files" />}
        {rows.length === 0 ? (
          <EmptyState icon="attach_file" title="No files attached" />
        ) : (
          <div className="lc-list">
            {rows.map(({ file: f }) => (
              <Link key={f.id} href={`/drive/files/${f.id}`} className="lc-popover-item" style={{ padding: '10px 16px' }}>
                <Icon name={KIND_ICON[fileKind(f.name, f.mime)]} />
                <span style={{ flex: 1 }} className="lc-ellipsis">{f.name}</span>
                <span className="lc-mono lc-muted" style={{ fontSize: 12 }}>{fmt.bytes(f.size)} · {fmt.shortDate(f.createdAt)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  };
}
