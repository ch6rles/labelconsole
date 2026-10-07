'use client';

import { useMemo } from 'react';
import { Icon, fmt } from '@labelconsole/ui';
import { sniff } from './inspect';
import { downloadHref, type ViewerProps } from './shared';

const hex2 = (b: number) => b.toString(16).padStart(2, '0');

/**
 * Files with no viewer: what they appear to be, a download, and the first
 * 2 KB as a hex dump for the curious.
 */
export function BinaryViewer({ file, hex, bytes }: ViewerProps & { hex: string; bytes: number }) {
  const data = useMemo(() => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)), [hex]);
  const guess = sniff(data);
  const rows = [];
  for (let o = 0; o < data.length; o += 16) {
    const chunk = data.slice(o, o + 16);
    rows.push(
      <div key={o} className="lc-fv-hex-row">
        <span className="lc-fv-hex-off">{o.toString(16).padStart(8, '0')}</span>
        <span className="lc-fv-hex-bytes">
          {Array.from({ length: 16 }, (_, i) => (i < chunk.length ? hex2(chunk[i]) : '  ')).join(' ').replace(/^(.{23}) /, '$1  ')}
        </span>
        <span className="lc-fv-hex-ascii">{Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join('')}</span>
      </div>,
    );
  }
  return (
    <div className="lc-fv lc-fv-binary">
      <div className="lc-fv-stage lc-fv-scroll">
        <div className="lc-fv-binary-head">
          <Icon name="draft" size={32} />
          <div>
            <strong>No preview for this kind of file</strong>
            <span className="lc-muted">
              {guess ? `Looks like: ${guess}. ` : ''}
              {fmt.bytes(file.size)} · {file.mime || 'unknown type'}. Download it to open it in its own app.
            </span>
          </div>
          <a className="lc-btn lc-btn--primary lc-btn--sm" href={downloadHref(file.id)}>
            <Icon name="download" />
            Download
          </a>
        </div>
        {bytes > 0 && (
          <>
            <div className="lc-fv-side-title">First {fmt.bytes(bytes)}</div>
            <div className="lc-fv-hex" aria-label="Hex dump">
              {rows}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
