'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Notice, Spacer, ToolButton, Toolbar, clamp, contentUrl, toggleFullscreen, useKeys, type ViewerProps } from './shared';

const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

/**
 * Images: fit to the window, or zoom (buttons, wheel, keys, double-click) and
 * drag to look around; rotate in quarter turns; transparent areas on a
 * checkerboard. Formats the browser can't draw (HEIC, TIFF outside Safari)
 * fall back to a download.
 */
export function ImageViewer({ file, compact }: ViewerProps) {
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const turned = rotation % 180 !== 0;
  const fitScale = natural && box.w && box.h ? Math.min(1, (box.w - 32) / (turned ? natural.h : natural.w), (box.h - 32) / (turned ? natural.w : natural.h)) : 1;
  const scale = zoom === 'fit' ? fitScale : zoom;
  const setScale = useCallback((next: number | 'fit') => {
    setZoom(next === 'fit' ? 'fit' : clamp(next, 0.05, 16));
    if (next === 'fit') setOffset({ x: 0, y: 0 });
  }, []);
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? STEPS.find((s) => s > scale + 0.001) : [...STEPS].reverse().find((s) => s < scale - 0.001);
    setScale(next ?? (dir > 0 ? STEPS.at(-1)! : STEPS[0]));
  };

  useKeys((e) => {
    if (e.key === '+' || e.key === '=') step(1);
    else if (e.key === '-') step(-1);
    else if (e.key === '0') setScale('fit');
    else if (e.key === '1') setScale(1);
    else if (e.key.toLowerCase() === 'r') setRotation((r) => (r + (e.shiftKey ? 270 : 90)) % 360);
    else return;
    e.preventDefault();
  }, !compact);

  const onWheel = useRef<(e: WheelEvent) => void>(() => undefined);
  onWheel.current = (e: WheelEvent) => {
    // In the side panel the wheel scrolls the panel unless Ctrl (or a pinch) asks to zoom.
    if (compact && !e.ctrlKey) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const next = clamp(scale * factor, 0.05, 16);
    const rect = stage.current!.getBoundingClientRect();
    // Zoom about the pointer.
    const px = e.clientX - rect.left - rect.width / 2 - offset.x;
    const py = e.clientY - rect.top - rect.height / 2 - offset.y;
    setOffset({ x: offset.x - px * (next / scale - 1), y: offset.y - py * (next / scale - 1) });
    setZoom(next);
  };
  // A native listener: React's wheel listener is passive and can't stop the page scrolling.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const handle = (e: WheelEvent) => onWheel.current(e);
    el.addEventListener('wheel', handle, { passive: false });
    return () => el.removeEventListener('wheel', handle);
  }, [failed]);
  const onPointerDown = (e: PointerEvent) => {
    if (zoom === 'fit' && scale >= fitScale) return;
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag.current) return;
    setOffset({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y });
  };

  if (failed) return <Notice icon="hide_image" title="This browser can’t show this image" file={file}>HEIC and TIFF pictures only open in Safari. Download it to open it in your photo app.</Notice>;

  return (
    <div className="lc-fv lc-fv-image">
      <Toolbar>
        <ToolButton icon="zoom_out" title="Zoom out (−)" onClick={() => step(-1)} />
        <button type="button" className="lc-fv-zoom" onClick={() => setScale(zoom === 'fit' ? 1 : 'fit')} title="Fit to window / actual size (0 / 1)">
          {zoom === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`}
        </button>
        <ToolButton icon="zoom_in" title="Zoom in (+)" onClick={() => step(1)} />
        <ToolButton icon="fit_screen" title="Fit to window (0)" onClick={() => setScale('fit')} active={zoom === 'fit'} />
        <ToolButton icon="crop_free" title="Actual size (1)" onClick={() => setScale(1)} active={zoom === 1} />
        <ToolButton icon="rotate_left" title="Rotate left (Shift+R)" onClick={() => setRotation((r) => (r + 270) % 360)} />
        <ToolButton icon="rotate_right" title="Rotate right (R)" onClick={() => setRotation((r) => (r + 90) % 360)} />
        <Spacer />
        {natural && <span className="lc-fv-meta">{natural.w} × {natural.h} px</span>}
        <ToolButton icon="fullscreen" title="Full screen" onClick={() => toggleFullscreen(stage.current)} />
      </Toolbar>
      <div
        ref={stage}
        className={`lc-fv-stage lc-fv-checker${scale > fitScale + 0.001 ? ' is-pannable' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => setScale(zoom === 'fit' ? 1 : 'fit')}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={contentUrl(file.id)}
          alt={file.name}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          style={{
            width: natural ? natural.w : undefined,
            height: natural ? natural.h : undefined,
            maxWidth: 'none',
            transform: `translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg) scale(${scale})`,
            opacity: natural ? 1 : 0,
          }}
        />
      </div>
    </div>
  );
}
