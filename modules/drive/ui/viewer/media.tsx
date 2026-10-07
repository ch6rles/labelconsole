'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Icon, fmt } from '@labelconsole/ui';
import { levelsOf, peaksOf, readTags, type AudioTags, type Levels } from './audio-analysis';
import { Notice, Spacer, ToolButton, Toolbar, clamp, contentUrl, duration, toggleFullscreen, useKeys, usePref, type ViewerProps } from './shared';

/** Waveforms are drawn for files up to this size (the whole file is read once to draw it). */
const WAVE_MAX_BYTES = 120 * 1024 * 1024;
/** Loudness is measured for tracks up to this long; DJ mixes and podcasts would hold up the page. */
const LEVELS_MAX_SECONDS = 20 * 60;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

type Analysis = { peaks: Float32Array; sampleRate: number; channels: number; length: number; levels: Levels | null };

function useMediaKeys(el: () => HTMLMediaElement | null, enabled: boolean, extra?: (e: KeyboardEvent) => boolean) {
  useKeys((e) => {
    const m = el();
    if (!m || e.ctrlKey) return;
    if (extra?.(e)) return e.preventDefault();
    const seek = (by: number) => (m.currentTime = clamp(m.currentTime + by, 0, m.duration || 0));
    if (e.key === ' ' || e.key === 'k') void (m.paused ? m.play() : m.pause());
    else if (e.key === 'ArrowLeft') seek(-5);
    else if (e.key === 'ArrowRight') seek(5);
    else if (e.key === 'j') seek(-10);
    else if (e.key === 'l') seek(10);
    else if (e.key === 'm') m.muted = !m.muted;
    else if (/^[0-9]$/.test(e.key) && Number.isFinite(m.duration)) m.currentTime = (m.duration * Number(e.key)) / 10;
    else return;
    e.preventDefault();
  }, enabled);
}

/**
 * Audio: a waveform to see the track's shape and click to any point, with
 * playback speed, looping and volume; the file's tags and artwork (title,
 * artist, ISRC, BPM, key); and its levels: peak, RMS and integrated loudness
 * in LUFS against the −14 LUFS the streaming services play at.
 */
export function AudioViewer({ file, compact }: ViewerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(NaN);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = usePref('volume', 1);
  const [muted, setMuted] = useState(false);
  const [loop, setLoop] = useState(false);
  const [failed, setFailed] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | 'loading' | 'unavailable'>(file.size <= WAVE_MAX_BYTES ? 'loading' : 'unavailable');
  const [tags, setTags] = useState<AudioTags | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const dragging = useRef(false);

  // Read the whole file once: tags, waveform, levels.
  useEffect(() => {
    if (file.size > WAVE_MAX_BYTES) return;
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      const buf = await fetch(contentUrl(file.id), { credentials: 'same-origin', signal: controller.signal }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      if (cancelled) return;
      setTags(readTags(buf));
      const ctx = new AudioContext();
      try {
        const decoded = await ctx.decodeAudioData(buf);
        if (cancelled) return;
        const base: Analysis = { peaks: peaksOf(decoded, 1600), sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, length: decoded.duration, levels: null };
        setAnalysis(base);
        if (decoded.duration <= LEVELS_MAX_SECONDS) {
          // Let the waveform paint first.
          await new Promise((r) => setTimeout(r, 50));
          if (!cancelled) setAnalysis({ ...base, levels: levelsOf(decoded) });
        }
      } finally {
        void ctx.close();
      }
    })().catch(() => !cancelled && setAnalysis('unavailable'));
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [file.id, file.size]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [failed]);

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    a.volume = volume;
    a.muted = muted;
    a.playbackRate = rate;
    a.loop = loop;
  }, [volume, muted, rate, loop]);

  // Follow playback smoothly while playing.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      if (audio.current && !dragging.current) setTime(audio.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const total = Number.isFinite(dur) ? dur : typeof analysis === 'object' ? analysis.length : NaN;

  // Draw the waveform: played part in the accent colour, the rest grey, the hover point marked.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !width || typeof analysis !== 'object') return;
    const h = 120;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.floor(width * dpr);
    c.height = Math.floor(h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, h);
    const styles = getComputedStyle(c);
    const played = styles.getPropertyValue('--lc-accent').trim() || '#2563eb';
    const rest = styles.getPropertyValue('--lc-line-strong').trim() || '#cbd5e1';
    const hoverCol = styles.getPropertyValue('--lc-accent-light').trim() || '#93c5fd';
    const bar = 2;
    const gap = 1;
    const bars = Math.floor(width / (bar + gap));
    const max = Math.max(0.01, ...analysis.peaks);
    const progress = Number.isFinite(total) && total > 0 ? time / total : 0;
    for (let i = 0; i < bars; i++) {
      const from = Math.floor((i / bars) * analysis.peaks.length);
      const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * analysis.peaks.length));
      let p = 0;
      for (let k = from; k < to; k++) p = Math.max(p, analysis.peaks[k]);
      const bh = Math.max(1, (p / max) * (h - 8));
      const x = i * (bar + gap);
      const at = i / bars;
      g.fillStyle = at < progress ? played : hover !== null && at < hover ? hoverCol : rest;
      g.fillRect(x, (h - bh) / 2, bar, bh);
    }
  }, [analysis, width, time, total, hover]);

  const seekTo = (frac: number) => {
    const a = audio.current;
    if (!a || !Number.isFinite(total)) return;
    a.currentTime = clamp(frac, 0, 1) * total;
    setTime(a.currentTime);
  };
  const fracAt = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };

  const toggle = useCallback(() => {
    const a = audio.current;
    if (a) void (a.paused ? a.play() : a.pause());
  }, []);
  useMediaKeys(() => audio.current, !compact, (e) => {
    if (e.key === 'L') {
      setLoop((v) => !v);
      return true;
    }
    return false;
  });

  if (failed)
    return (
      <Notice icon="music_off" title="This browser can’t play this audio" file={file}>
        AIFF plays in Safari only, and some formats (WMA, ALAC in Firefox) don’t play in browsers at all. Download it to listen.
      </Notice>
    );

  const lv = typeof analysis === 'object' ? analysis.levels : null;
  const tagRows: Array<[string, string | undefined]> = tags
    ? [
        ['Album', tags.album],
        ['Album artist', tags.albumArtist !== tags.artist ? tags.albumArtist : undefined],
        ['Year', tags.year],
        ['Genre', tags.genre],
        ['Track', tags.track],
        ['ISRC', tags.isrc],
        ['BPM', tags.bpm],
        ['Key', tags.key],
        ['Label', tags.label],
        ['Composer', tags.composer],
        ['Copyright', tags.copyright],
      ]
    : [];

  return (
    <div className="lc-fv lc-fv-audio">
      <audio
        ref={audio}
        src={contentUrl(file.id)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => !playing && setTime(e.currentTarget.currentTime)}
        onError={() => setFailed(true)}
      />
      <div className="lc-fv-stage lc-fv-scroll">
        <div className="lc-fv-audio-body">
          <div className="lc-fv-audio-head">
            <span className="lc-fv-art">
              {tags?.picture ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={tags.picture} alt="Artwork" />
              ) : (
                <Icon name="music_note" size={36} />
              )}
            </span>
            <div className="lc-fv-audio-title">
              <strong>{tags?.title || file.name.replace(/\.[^.]+$/, '')}</strong>
              {tags?.artist && <span>{tags.artist}</span>}
              <span className="lc-muted lc-mono">
                {[typeof analysis === 'object' ? `${(analysis.sampleRate / 1000).toFixed(1)} kHz` : null, typeof analysis === 'object' ? (analysis.channels === 1 ? 'mono' : analysis.channels === 2 ? 'stereo' : `${analysis.channels} channels`) : null, fmt.bytes(file.size), Number.isFinite(total) && total > 0 ? `${Math.round((file.size * 8) / total / 1000)} kbps` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
          </div>

          <div
            ref={wrap}
            className="lc-fv-wave"
            onPointerDown={(e) => {
              dragging.current = true;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              seekTo(fracAt(e));
            }}
            onPointerMove={(e) => {
              const f = fracAt(e);
              setHover(f);
              if (dragging.current) seekTo(f);
            }}
            onPointerUp={() => (dragging.current = false)}
            onPointerLeave={() => setHover(null)}
            role="slider"
            aria-label="Position"
            aria-valuemin={0}
            aria-valuemax={Math.round(total) || 0}
            aria-valuenow={Math.round(time)}
            aria-valuetext={`${duration(time)} of ${duration(total)}`}
            tabIndex={0}
          >
            {typeof analysis === 'object' ? (
              <canvas ref={canvas} style={{ width: '100%', height: 120 }} />
            ) : (
              <div className="lc-fv-wave-plain">
                <div style={{ width: `${Number.isFinite(total) && total > 0 ? (time / total) * 100 : 0}%` }} />
                {analysis === 'loading' && <span>Drawing waveform…</span>}
              </div>
            )}
            {hover !== null && Number.isFinite(total) && (
              <span className="lc-fv-wave-tip" style={{ left: `${hover * 100}%` }}>
                {duration(hover * total)}
              </span>
            )}
          </div>

          <div className="lc-fv-transport">
            <ToolButton icon="replay_10" title="Back 10 seconds (J)" onClick={() => audio.current && (audio.current.currentTime = Math.max(0, audio.current.currentTime - 10))} />
            <button type="button" className="lc-fv-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
              <Icon name={playing ? 'pause' : 'play_arrow'} size={28} />
            </button>
            <ToolButton icon="forward_10" title="Forward 10 seconds (L)" onClick={() => audio.current && (audio.current.currentTime = Math.min(total || 0, audio.current.currentTime + 10))} />
            <span className="lc-fv-time lc-mono">
              {duration(time)} / {duration(total)}
            </span>
            <Spacer />
            <ToolButton icon={loop ? 'repeat_on' : 'repeat'} title="Loop (Shift+L)" onClick={() => setLoop(!loop)} active={loop} />
            <select className="lc-fv-select" value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Playback speed" title="Playback speed">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
            <ToolButton icon={muted || volume === 0 ? 'volume_off' : volume < 0.5 ? 'volume_down' : 'volume_up'} title="Mute (M)" onClick={() => setMuted(!muted)} active={muted} />
            <input className="lc-fv-volume" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => (setVolume(Number(e.target.value)), setMuted(false))} aria-label="Volume" />
          </div>

          {(lv || analysis === 'loading' || (typeof analysis === 'object' && analysis.length <= LEVELS_MAX_SECONDS)) && (
            <div className="lc-fv-levels">
              <Level label="Loudness" value={lv?.lufs != null ? `${lv.lufs.toFixed(1)} LUFS` : lv ? 'silent' : '…'} note={lv?.lufs != null ? loudnessNote(lv.lufs) : 'integrated, BS.1770'} />
              <Level label="Peak" value={lv ? `${Number.isFinite(lv.peakDb) ? lv.peakDb.toFixed(1) : '−∞'} dBFS` : '…'} note={lv && lv.peakDb > -0.1 ? 'at or near clipping' : 'sample peak'} warn={Boolean(lv && lv.peakDb > -0.1)} />
              <Level label="RMS" value={lv ? `${Number.isFinite(lv.rmsDb) ? lv.rmsDb.toFixed(1) : '−∞'} dBFS` : '…'} note="average level" />
              <Level label="Length" value={duration(total)} note={typeof analysis === 'object' ? `${analysis.sampleRate.toLocaleString()} Hz` : ''} />
            </div>
          )}

          {tagRows.some(([, v]) => v) && (
            <dl className="lc-fv-tags">
              {tagRows
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd className={k === 'ISRC' ? 'lc-mono' : undefined}>{v}</dd>
                  </div>
                ))}
            </dl>
          )}
          {analysis === 'unavailable' && file.size > WAVE_MAX_BYTES && <p className="lc-muted">This file is too large to draw a waveform for; playback works as normal.</p>}
        </div>
      </div>
    </div>
  );
}

function loudnessNote(lufs: number) {
  const diff = lufs + 14;
  if (Math.abs(diff) < 1) return 'right at the −14 LUFS streaming level';
  return diff > 0 ? `streaming services will turn it down ~${diff.toFixed(1)} dB` : `${(-diff).toFixed(1)} dB under the −14 LUFS streaming level`;
}

function Level({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <div className={`lc-fv-level${warn ? ' is-warn' : ''}`}>
      <span className="lc-fv-level-label">{label}</span>
      <strong className="lc-mono">{value}</strong>
      {note && <span className="lc-fv-level-note">{note}</span>}
    </div>
  );
}

/**
 * Video: the browser's player with speed, looping, picture-in-picture, a
 * still of the current frame saved as PNG, and the video's size and length.
 */
export function VideoViewer({ file, compact }: ViewerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [meta, setMeta] = useState<{ w: number; h: number; d: number } | null>(null);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [pip, setPip] = useState(false);
  useEffect(() => setPip(Boolean(document.pictureInPictureEnabled)), []);

  useEffect(() => {
    if (video.current) {
      video.current.playbackRate = rate;
      video.current.loop = loop;
    }
  }, [rate, loop]);

  useMediaKeys(() => video.current, !compact, (e) => {
    if (e.key === 'f') {
      toggleFullscreen(root.current);
      return true;
    }
    return false;
  });

  const snapshot = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${file.name.replace(/\.[^.]+$/, '')} ${duration(v.currentTime).replace(/:/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  };

  if (failed)
    return (
      <Notice icon="videocam_off" title="This browser can’t play this video" file={file}>
        MKV files and HEVC (H.265) videos from iPhones often only play in Safari or a desktop player. Download it to watch.
      </Notice>
    );

  return (
    <div className="lc-fv lc-fv-video" ref={root}>
      <Toolbar>
        <select className="lc-fv-select" value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Playback speed" title="Playback speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <ToolButton icon={loop ? 'repeat_on' : 'repeat'} title="Loop" onClick={() => setLoop(!loop)} active={loop} />
        <ToolButton icon="photo_camera" title="Save this frame as a picture" onClick={snapshot} disabled={!meta} />
        {pip && (
          <ToolButton icon="picture_in_picture_alt" title="Picture in picture" onClick={() => void (document.pictureInPictureElement ? document.exitPictureInPicture() : video.current?.requestPictureInPicture())} disabled={!meta} />
        )}
        <Spacer />
        {meta && (
          <span className="lc-fv-meta">
            {meta.w} × {meta.h} · {duration(meta.d)}
          </span>
        )}
        <ToolButton icon="fullscreen" title="Full screen (F)" onClick={() => toggleFullscreen(root.current)} />
      </Toolbar>
      <div className="lc-fv-stage lc-fv-video-stage">
        <video
          ref={video}
          src={contentUrl(file.id)}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => setMeta({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight, d: e.currentTarget.duration })}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  );
}
