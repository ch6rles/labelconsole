'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError, FieldInput, type FieldSpec } from '@labelconsole/ui/client';
import { Icon } from '@labelconsole/ui';

type Mode = 'login' | 'setup' | 'invite';

const FIELDS: Record<Mode, FieldSpec[]> = {
  login: [
    { name: 'email', label: 'Email', type: 'email', required: true, full: true },
    { name: 'password', label: 'Password', type: 'password', required: true, full: true },
  ],
  setup: [
    { name: 'name', label: 'Your name', required: true, full: true },
    { name: 'email', label: 'Email', type: 'email', required: true, full: true, hint: 'You sign in with this.' },
    { name: 'password', label: 'Password', type: 'password', required: true, full: true, hint: 'At least 10 characters.' },
  ],
  invite: [
    { name: 'name', label: 'Your name', full: true, hint: 'Skip if you already have an account.' },
    { name: 'password', label: 'Password', type: 'password', required: true, full: true, hint: 'Your existing password, or a new one (10+ characters).' },
  ],
};

export function AuthForm({ mode, token, inviteLabel, labelName }: { mode: Mode; token?: string; inviteLabel?: string; labelName?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const path = mode === 'invite' ? `/api/auth/invite/${token}` : `/api/auth/${mode}`;
      await api(path, { method: 'POST', body: values });
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.details && 'fieldErrors' in err.details) {
        const fe = (err.details.fieldErrors ?? {}) as Record<string, string[]>;
        setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v[0]])));
        if (Object.keys(fe).length === 0) setError(err.message);
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'login' ? 'Sign in' : mode === 'setup' ? `Set up ${labelName ?? 'your label'}` : `Join ${inviteLabel ?? 'the label'}`;
  return (
    <div className="lc-auth">
      <form className="lc-auth-card" onSubmit={submit} noValidate>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="lc-brand-code">LC</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="lc-brand-name">Label Console</span>
            <span className="lc-brand-sub">{labelName ?? inviteLabel ?? 'Label workspace'}</span>
          </div>
        </div>
        <h1 className="lc-h1" style={{ fontSize: 24 }}>
          {title}
        </h1>
        <div className="lc-form-grid lc-form-grid--1">
          {FIELDS[mode].map((f) => (
            <FieldInput key={f.name} f={f} value={values[f.name]} error={errors[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
          ))}
        </div>
        {error && (
          <div className="lc-banner is-warn">
            <Icon name="error" />
            <div>{error}</div>
          </div>
        )}
        <button type="submit" className="lc-btn lc-btn--primary" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Sign in' : mode === 'setup' ? 'Create owner account' : 'Accept invitation'}
        </button>
        <div style={{ fontSize: 13, color: 'var(--lc-muted)' }}>
          {mode === 'login' ? (
            'Need access? Ask the label owner for an invitation.'
          ) : mode === 'setup' ? (
            'This creates the owner account. Afterwards, add your team by invitation under Admin.'
          ) : (
            <>
              Already have an account? <Link href="/login">Sign in</Link>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
