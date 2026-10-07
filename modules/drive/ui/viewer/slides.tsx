'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@labelconsole/ui';
import type { SlidePreview } from '../../preview';
import { Segmented, Spacer, ToolButton, Toolbar, toggleFullscreen, useKeys, usePref, type ViewerProps } from './shared';

/**
 * PowerPoint decks: each slide's title, text and pictures with its speaker
 * notes; a strip of slides to jump between, a grid of all of them, and a
 * full-screen mode to click through.
 */
export function SlidesViewer({ compact, slides, truncated }: ViewerProps & { slides: SlidePreview[]; truncated: boolean }) {
  const [i, setI] = useState(0);
  const [view, setView] = usePref<'slide' | 'grid'>('slides-view', 'slide');
  const [notes, setNotes] = usePref('slides-notes', true);
  const stage = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const go = (n: number) => setI(Math.max(0, Math.min(slides.length - 1, n)));

  useKeys((e) => {
    if (view !== 'slide') return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) go(i + 1);
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(slides.length - 1);
    else if (e.key === 'f') toggleFullscreen(stage.current);
    else return;
    e.preventDefault();
  }, !compact);

  useEffect(() => {
    rail.current?.querySelector(`[data-slide="${i}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [i]);

  if (!slides.length) return <div className="lc-fv-notice"><Icon name="slideshow" size={32} /><strong>This presentation has no slides</strong></div>;
  const slide = slides[i];

  return (
    <div className="lc-fv lc-fv-slides">
      <Toolbar>
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'slide', label: 'Slide', icon: 'crop_landscape' },
            { value: 'grid', label: 'All slides', icon: 'grid_view' },
          ]}
        />
        {view === 'slide' && (
          <>
            <ToolButton icon="chevron_left" title="Previous slide (←)" onClick={() => go(i - 1)} disabled={i === 0} />
            <span className="lc-fv-meta">
              {i + 1} / {slides.length}
            </span>
            <ToolButton icon="chevron_right" title="Next slide (→)" onClick={() => go(i + 1)} disabled={i === slides.length - 1} />
          </>
        )}
        <Spacer />
        {view === 'slide' && <ToolButton icon="speaker_notes" title="Speaker notes" onClick={() => setNotes(!notes)} active={notes} />}
        {view === 'slide' && <ToolButton icon="slideshow" title="Present full screen (F)" onClick={() => toggleFullscreen(stage.current)} />}
      </Toolbar>
      {truncated && <div className="lc-fv-banner">Showing the first {slides.length} slides. Download the file for the rest.</div>}
      {view === 'grid' ? (
        <div className="lc-fv-stage lc-fv-scroll">
          <div className="lc-fv-slide-grid">
            {slides.map((s, k) => (
              <button
                key={k}
                type="button"
                className="lc-fv-slide-pick"
                onClick={() => {
                  setI(k);
                  setView('slide');
                }}
              >
                <SlideCard slide={s} small />
                <span>
                  {s.index}. {s.title ?? 'Untitled slide'}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="lc-fv-body">
          {!compact && slides.length > 1 && (
            <div className="lc-fv-side lc-fv-slide-rail" ref={rail}>
              {slides.map((s, k) => (
                <button key={k} type="button" data-slide={k} className={`lc-fv-slide-pick${k === i ? ' is-active' : ''}`} onClick={() => setI(k)} aria-current={k === i ? 'true' : undefined}>
                  <SlideCard slide={s} small />
                  <span className="lc-fv-slide-no">{s.index}</span>
                </button>
              ))}
            </div>
          )}
          <div className="lc-fv-stage lc-fv-scroll lc-fv-slide-stage" ref={stage} onClick={(e) => document.fullscreenElement && (e.clientX > window.innerWidth / 2 ? go(i + 1) : go(i - 1))}>
            <SlideCard slide={slide} />
            {notes && slide.notes && (
              <div className="lc-fv-notes">
                <strong>Speaker notes</strong>
                <p>{slide.notes}</p>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="lc-fv-status">
        <span>{slides.length} slides</span>
        <span>{slides.filter((s) => s.notes).length} with notes</span>
        <span className="lc-muted">Text and pictures only: open in PowerPoint or Keynote for the full design.</span>
      </div>
    </div>
  );
}

function SlideCard({ slide, small }: { slide: SlidePreview; small?: boolean }) {
  const hasText = Boolean(slide.title || slide.paragraphs.length);
  const images = slide.images.slice(0, small ? 1 : 6);
  return (
    <div className={`lc-fv-slide${small ? ' is-small' : ''}${images.length && !hasText ? ' is-picture' : ''}`}>
      {hasText && (
        <div className="lc-fv-slide-text">
          {slide.title && <h2>{slide.title}</h2>}
          {!small && slide.paragraphs.length > 0 && (
            <ul>
              {slide.paragraphs.map((p, k) => (
                <li key={k} style={{ marginLeft: p.level * 20 }} className={p.level ? 'is-sub' : undefined}>
                  {p.text}
                </li>
              ))}
            </ul>
          )}
          {small && !slide.title && slide.paragraphs[0] && <p>{slide.paragraphs[0].text}</p>}
        </div>
      )}
      {images.length > 0 && (
        <div className="lc-fv-slide-pics">
          {images.map((src, k) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={k} src={src} alt="" />
          ))}
        </div>
      )}
      {!hasText && !images.length && <span className="lc-muted">Blank slide</span>}
    </div>
  );
}
