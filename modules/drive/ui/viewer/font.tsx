'use client';

import { useEffect, useState } from 'react';
import { extensionOf } from '../../kinds';
import { fontInfo, fontTables, type FontInfo } from './inspect';
import { Notice, Segmented, Spacer, Toolbar, contentUrl, type ViewerProps } from './shared';

const SETS: Record<string, string> = {
  Uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  Lowercase: 'abcdefghijklmnopqrstuvwxyz',
  Numbers: '0123456789',
  Punctuation: '.,:;!?¡¿\'"‘’“”«»()[]{}/\\|-–—_@#&%*+=<>~^$€£¥',
  Accents: 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝßàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ',
};
const SIZES = [12, 16, 20, 24, 32, 48, 64, 96];
const PANGRAM = 'The quick brown fox jumps over the lazy dog';

/**
 * Fonts: the font itself on an editable line at any size, a waterfall of
 * sizes, its characters by set, and what the file says about itself (family,
 * style, version, designer, licence, glyph count).
 */
export function FontViewer({ file }: ViewerProps) {
  const family = `lc-font-${file.id}`;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [info, setInfo] = useState<FontInfo | null>(null);
  const [sample, setSample] = useState(PANGRAM);
  const [size, setSize] = useState(48);
  const [view, setView] = useState<'type' | 'glyphs'>('type');
  const [dark, setDark] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let face: FontFace | null = null;
    fetch(contentUrl(file.id), { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(async (buf) => {
        face = new FontFace(family, buf);
        await face.load();
        if (cancelled) return;
        document.fonts.add(face);
        setReady(true);
        const tables = await fontTables(buf).catch(() => null);
        if (!cancelled) setInfo(tables ? fontInfo(tables) : {});
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (face) document.fonts.delete(face);
    };
  }, [file.id, family]);

  if (failed) return <Notice icon="font_download_off" title="This font couldn’t be loaded" file={file}>It may be damaged, or a format browsers don’t support.</Notice>;
  if (!ready) return <Notice busy icon="progress_activity" title="Loading font…" />;

  const style = { fontFamily: `"${family}", system-ui` };
  const rows: Array<[string, string | number | undefined]> = info
    ? [
        ['Family', info.family],
        ['Style', info.style],
        ['Full name', info.full],
        ['Version', info.version?.replace(/^Version\s*/i, '')],
        ['Designer', info.designer],
        ['Foundry', info.maker],
        ['Glyphs', info.glyphs?.toLocaleString()],
        ['Format', extensionOf(file.name).toUpperCase()],
        ['Copyright', info.copyright],
        ['Licence', info.license],
        ['Licence link', info.licenseUrl],
      ]
    : [];

  return (
    <div className={`lc-fv lc-fv-font${dark ? ' is-dark' : ''}`}>
      <Toolbar>
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'type', label: 'Type tester', icon: 'text_fields' },
            { value: 'glyphs', label: 'Characters', icon: 'apps' },
          ]}
        />
        <Spacer />
        {view === 'type' && (
          <label className="lc-fv-range">
            <span>{size}px</span>
            <input type="range" min={8} max={160} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Sample size" />
          </label>
        )}
        <button type="button" className={`lc-fv-tool${dark ? ' is-active' : ''}`} onClick={() => setDark(!dark)} title="Light text on dark" aria-pressed={dark}>
          Aa
        </button>
      </Toolbar>
      <div className="lc-fv-stage lc-fv-scroll">
        <div className="lc-fv-font-body">
          {view === 'type' ? (
            <>
              <input className="lc-fv-font-sample" style={{ ...style, fontSize: size }} value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Sample text (type to try your own)" spellCheck={false} />
              <div className="lc-fv-waterfall">
                {SIZES.map((s) => (
                  <div key={s}>
                    <span className="lc-fv-meta">{s}</span>
                    <span style={{ ...style, fontSize: s }}>{sample || PANGRAM}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            Object.entries(SETS).map(([name, chars]) => (
              <section key={name} className="lc-fv-glyphs">
                <h3>{name}</h3>
                <div>
                  {[...chars].map((c) => (
                    <span key={c} style={style} title={`U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`}>
                      {c}
                    </span>
                  ))}
                </div>
              </section>
            ))
          )}
          {rows.some(([, v]) => v) && (
            <dl className="lc-fv-font-info">
              {rows
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}
