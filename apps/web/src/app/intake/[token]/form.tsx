'use client';

import { useState } from 'react';
import { Icon } from '@labelconsole/ui';

export function IntakeForm({ token, label }: { token: string; label: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  if (state === 'done')
    return (
      <div className="lc-auth">
        <div className="lc-auth-card" style={{ textAlign: 'center' }}>
          <Icon name="check_circle" size={36} style={{ color: 'var(--lc-accent)', margin: '0 auto' }} />
          <h1 className="lc-h1" style={{ fontSize: 22 }}>Thanks, we got it</h1>
          <p className="lc-lede">The {label} A&R team reviews every submission. We will be in touch if it is a fit.</p>
        </div>
      </div>
    );
  return (
    <div className="lc-auth">
      <form
        className="lc-auth-card"
        style={{ width: 'min(520px, 100%)' }}
        onSubmit={async (e) => {
          e.preventDefault();
          setState('sending');
          setError(null);
          const res = await fetch(`/api/intake/${token}`, { method: 'POST', body: new FormData(e.currentTarget) });
          if (res.ok) setState('done');
          else {
            setError((await res.json().catch(() => null))?.error?.message ?? 'Something went wrong');
            setState('idle');
          }
        }}
      >
        <span className="lc-section-label">{label}</span>
        <h1 className="lc-h1" style={{ fontSize: 24 }}>Submit a demo</h1>
        <div className="lc-form-grid">
          <label className="lc-field"><span className="lc-field-label">Track title</span><input className="lc-input" name="title" required /></label>
          <label className="lc-field"><span className="lc-field-label">Artist name</span><input className="lc-input" name="artistName" required /></label>
          <label className="lc-field"><span className="lc-field-label">Your name</span><input className="lc-input" name="name" /></label>
          <label className="lc-field"><span className="lc-field-label">Email</span><input className="lc-input" name="email" type="email" required /></label>
          <label className="lc-field"><span className="lc-field-label">Genre</span><input className="lc-input" name="genre" /></label>
          <label className="lc-field" style={{ gridColumn: '1 / -1' }}><span className="lc-field-label">Links (SoundCloud, YouTube, private links)</span><input className="lc-input" name="links" placeholder="https://…" /></label>
          <label className="lc-field" style={{ gridColumn: '1 / -1' }}><span className="lc-field-label">Audio file (MP3, WAV, FLAC · up to 500 MB)</span><input className="lc-input" name="audio" type="file" accept="audio/*" style={{ paddingTop: 8 }} /></label>
          <label className="lc-field" style={{ gridColumn: '1 / -1' }}><span className="lc-field-label">Anything we should know</span><textarea className="lc-textarea" name="notes" rows={3} /></label>
          <input name="website" tabIndex={-1} autoComplete="off" style={{ position: 'absolute', left: -9999 }} aria-hidden="true" />
        </div>
        {error && <div className="lc-field-error">{error}</div>}
        <button className="lc-btn lc-btn--primary" type="submit" disabled={state === 'sending'}>{state === 'sending' ? 'Uploading…' : 'Send demo'}</button>
      </form>
    </div>
  );
}
