/**
 * What kind of file something is, for choosing a viewer. The declared type
 * alone isn't enough: browsers send nothing for many extensions, agents save
 * Markdown as text/plain, and Google exports arrive as octet streams. So the
 * extension decides first for text-like and Office formats, the type second.
 * Shared by the server (previews) and the browser (viewers).
 */
export type FileKind = 'image' | 'audio' | 'video' | 'pdf' | 'markdown' | 'html' | 'code' | 'text' | 'sheet' | 'document' | 'slides' | 'archive' | 'font' | 'other';

const EXT: Record<string, FileKind> = {
  // images
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', ico: 'image', svg: 'image', heic: 'image', heif: 'image', tif: 'image', tiff: 'image',
  // audio
  mp3: 'audio', wav: 'audio', wave: 'audio', flac: 'audio', aac: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', aif: 'audio', aiff: 'audio', weba: 'audio',
  // video
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', ogv: 'video', mkv: 'video',
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html',
  // spreadsheets
  csv: 'sheet', tsv: 'sheet', xlsx: 'sheet', xlsm: 'sheet',
  docx: 'document',
  pptx: 'slides',
  zip: 'archive',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  // plain text and code
  txt: 'text', log: 'text', lrc: 'text', srt: 'text', vtt: 'text', nfo: 'text', rtf: 'other',
  json: 'code', xml: 'code', yaml: 'code', yml: 'code', toml: 'code', ini: 'code', env: 'code', js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', css: 'code', scss: 'code',
  py: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code', kt: 'code', swift: 'code', c: 'code', h: 'code', cpp: 'code', cs: 'code', php: 'code', sh: 'code', sql: 'code', graphql: 'code',
};

export const extensionOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

export function fileKind(name: string, mime: string | null | undefined): FileKind {
  const ext = extensionOf(name);
  const m = (mime ?? '').toLowerCase();
  if (EXT[ext]) return EXT[ext];
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/markdown') return 'markdown';
  if (m === 'text/html') return 'html';
  if (m === 'text/csv' || m === 'text/tab-separated-values' || m.includes('spreadsheetml')) return 'sheet';
  if (m.includes('wordprocessingml')) return 'document';
  if (m.includes('presentationml')) return 'slides';
  if (m === 'application/zip' || m === 'application/x-zip-compressed') return 'archive';
  if (m.startsWith('font/')) return 'font';
  if (m === 'application/json' || m.endsWith('+json') || m.endsWith('/xml') || m.endsWith('+xml')) return 'code';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

export const KIND_LABEL: Record<FileKind, string> = {
  image: 'Image', audio: 'Audio', video: 'Video', pdf: 'PDF', markdown: 'Markdown', html: 'Web page', code: 'Code', text: 'Text',
  sheet: 'Spreadsheet', document: 'Word document', slides: 'Presentation', archive: 'Zip archive', font: 'Font', other: 'File',
};

export const KIND_ICON: Record<FileKind, string> = {
  image: 'image', audio: 'audio_file', video: 'movie', pdf: 'picture_as_pdf', markdown: 'article', html: 'html', code: 'code', text: 'description',
  sheet: 'table', document: 'description', slides: 'slideshow', archive: 'folder_zip', font: 'font_download', other: 'draft',
};

/** Formats this viewer can't show, with what to do instead. */
export function unsupportedReason(name: string): string | null {
  const ext = extensionOf(name);
  if (ext === 'doc') return 'Old Word files (.doc) can’t be previewed. Open it in Word or Google Docs and save it as .docx.';
  if (ext === 'xls') return 'Old Excel files (.xls) can’t be previewed. Save it as .xlsx or CSV.';
  if (ext === 'ppt') return 'Old PowerPoint files (.ppt) can’t be previewed. Save it as .pptx.';
  if (['pages', 'numbers', 'key'].includes(ext)) return 'Apple iWork files can’t be previewed. Export it as PDF, Word, Excel or PowerPoint.';
  if (['odt', 'ods', 'odp'].includes(ext)) return 'OpenDocument files can’t be previewed yet. Save it as PDF or an Office format.';
  if (['rar', '7z', 'tar', 'gz', 'tgz'].includes(ext)) return 'Only .zip archives can be listed. Download it to open it.';
  return null;
}
