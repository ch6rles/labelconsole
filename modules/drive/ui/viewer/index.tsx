'use client';

import { lazy, Suspense } from 'react';
import type { Preview } from '../../preview';
import { ImageViewer } from './image';
import { Notice, useJson, type ViewerProps } from './shared';

export type { ViewerFile, ViewerProps } from './shared';

// Heavy viewers load only when a file needs them (pdf.js alone is ~1 MB).
const PdfViewer = lazy(() => import('./pdf').then((m) => ({ default: m.PdfViewer })));
const AudioViewer = lazy(() => import('./media').then((m) => ({ default: m.AudioViewer })));
const VideoViewer = lazy(() => import('./media').then((m) => ({ default: m.VideoViewer })));
const FontViewer = lazy(() => import('./font').then((m) => ({ default: m.FontViewer })));
const TextViewer = lazy(() => import('./text').then((m) => ({ default: m.TextViewer })));
const SheetViewer = lazy(() => import('./sheet').then((m) => ({ default: m.SheetViewer })));
const DocumentViewer = lazy(() => import('./document').then((m) => ({ default: m.DocumentViewer })));
const SlidesViewer = lazy(() => import('./slides').then((m) => ({ default: m.SlidesViewer })));
const ArchiveViewer = lazy(() => import('./archive').then((m) => ({ default: m.ArchiveViewer })));
const BinaryViewer = lazy(() => import('./binary').then((m) => ({ default: m.BinaryViewer })));

const opening = <Notice busy icon="progress_activity" title="Opening…" />;

/**
 * Shows any Drive file the best way the browser can: images, audio, video,
 * PDFs and fonts from the file itself; text, code, spreadsheets, Word,
 * PowerPoint and zip archives from a preview the server builds; anything else
 * as what it appears to be, with a download.
 */
export function FileViewer(props: ViewerProps) {
  const { file } = props;
  return (
    <div className={`lc-fv-host${props.compact ? ' is-compact' : ''}`}>
      <Suspense fallback={opening}>
        {file.kind === 'image' ? (
          <ImageViewer {...props} />
        ) : file.kind === 'pdf' ? (
          <PdfViewer {...props} />
        ) : file.kind === 'audio' ? (
          <AudioViewer {...props} />
        ) : file.kind === 'video' ? (
          <VideoViewer {...props} />
        ) : file.kind === 'font' ? (
          <FontViewer {...props} />
        ) : (
          <PreviewedFile {...props} />
        )}
      </Suspense>
    </div>
  );
}

function PreviewedFile(props: ViewerProps) {
  const { file } = props;
  const { data, error, loading } = useJson<Preview>(`/api/v1/drive/files/${file.id}/preview`);
  if (loading || (!data && !error)) return opening;
  if (error || !data) return <Notice icon="error" title="This file couldn’t be opened" file={file}>{error}</Notice>;
  switch (data.kind) {
    case 'text':
      return <TextViewer {...props} preview={data} />;
    case 'sheet':
      return <SheetViewer {...props} sheets={data.sheets} />;
    case 'document':
      return <DocumentViewer {...props} html={data.html} />;
    case 'slides':
      return <SlidesViewer {...props} slides={data.slides} truncated={data.truncated} />;
    case 'archive':
      return <ArchiveViewer {...props} entries={data.entries} total={data.total} totalSize={data.totalSize} />;
    case 'binary':
      return <BinaryViewer {...props} hex={data.hex} bytes={data.bytes} />;
    case 'unsupported':
      return <Notice icon="visibility_off" title="No preview for this file" file={file}>{data.reason}</Notice>;
  }
}
