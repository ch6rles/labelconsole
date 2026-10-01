'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDebouncedCallback } from './hooks';
import { cx, Icon, Spinner } from './primitives';

/* ------------------------------------------------------------- api client -- */

export class ApiError extends Error {
  status: number;
  code: string;
  details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> } | Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: ApiError['details']) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const url = path.startsWith('/api/') ? path : `/api/v1${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
    headers: opts.form ? undefined : opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: opts.signal,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && typeof window !== 'undefined') window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return data as T;
}

/** Replace `{field}` placeholders in a path with values from an object. */
export function fill(template: string, values: Record<string, unknown>) {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(values[k] ?? '')));
}

/* ---------------------------------------------------------------- toasts -- */

type Toast = { id: number; message: string; kind: 'ok' | 'error' };
const ToastContext = createContext<(message: string, kind?: Toast['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="lc-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('lc-toast', t.kind === 'error' && 'is-error')}>
            <Icon name={t.kind === 'error' ? 'error' : 'check'} />
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/* --------------------------------------------------------------- buttons -- */

export type ButtonProps = {
  label?: ReactNode;
  icon?: string;
  variant?: 'primary' | 'ghost' | 'danger' | 'link';
  size?: 'sm' | 'xs';
  title?: string;
  block?: boolean;
};

export function Button({ label, icon, variant, size, title, block, onClick, type = 'button', disabled, loading, children }: ButtonProps & { onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean; loading?: boolean; children?: ReactNode }) {
  return (
    <button type={type} className={cx('lc-btn', variant && `lc-btn--${variant}`, size && `lc-btn--${size}`, block && 'lc-btn--block')} onClick={onClick} disabled={disabled || loading} title={title}>
      {loading ? <Spinner /> : icon && <Icon name={icon} />}
      {label}
      {children}
    </button>
  );
}

export function IconButton({ icon, title, onClick, tone, disabled }: { icon: string; title: string; onClick?: () => void; tone?: 'accent' | 'danger'; disabled?: boolean }) {
  return (
    <button type="button" className={cx('lc-icon-btn', tone && `is-${tone}`)} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  );
}

/** A button that calls an endpoint, then refreshes or navigates. All props are serializable. */
export function ActionButton({
  endpoint,
  method = 'POST',
  body,
  confirm,
  redirectTo,
  success,
  iconOnly,
  ...button
}: ButtonProps & { endpoint: string; method?: string; body?: unknown; confirm?: string; redirectTo?: string; success?: string; iconOnly?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try {
      const res = await api<Record<string, unknown>>(endpoint, { method, body: body ?? (method === 'DELETE' ? undefined : {}) });
      if (success) toast(success);
      if (redirectTo) router.push(fill(redirectTo, res ?? {}));
      else router.refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (iconOnly && button.icon) return <IconButton icon={button.icon} title={button.title ?? String(button.label ?? '')} onClick={run} tone={button.variant === 'danger' ? 'danger' : 'accent'} disabled={busy} />;
  return <Button {...button} onClick={run} loading={busy} />;
}

export function CopyButton({ text, label = 'Copy', icon = 'content_copy', ...rest }: ButtonProps & { text: string }) {
  const toast = useToast();
  return (
    <Button
      {...rest}
      icon={icon}
      label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        toast('Copied to clipboard');
      }}
    />
  );
}

/* --------------------------------------------------------- modal/drawer -- */

function usePortal() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.body), []);
  return el;
}

export function Modal({ open, onClose, title, description, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const portal = usePortal();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open || !portal) return null;
  return createPortal(
    <>
      <div className="lc-modal-backdrop" onClick={onClose} />
      <div className={cx('lc-modal', wide && 'lc-modal--wide')} role="dialog" aria-modal="true">
        <div className="lc-modal-head">
          <div className="lc-card-head-text">
            <span className="lc-card-title">{title}</span>
            {description && <span className="lc-card-sub">{description}</span>}
          </div>
          <IconButton icon="close" title="Close" onClick={onClose} />
        </div>
        <div className="lc-modal-body">{children}</div>
        {footer && <div className="lc-modal-foot">{footer}</div>}
      </div>
    </>,
    portal,
  );
}

/** Right-hand drawer. Open state can live in the URL (pass closeHref) or in React. */
export function Drawer({ open = true, onClose, closeHref, children, wide }: { open?: boolean; onClose?: () => void; closeHref?: string; children: ReactNode; wide?: boolean }) {
  const router = useRouter();
  const close = useCallback(() => {
    if (onClose) onClose();
    else if (closeHref) router.push(closeHref, { scroll: false });
  }, [onClose, closeHref, router]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
  if (!open) return null;
  return (
    <>
      <div className="lc-overlay" onClick={close} />
      <aside className={cx('lc-drawer', wide && 'lc-drawer--wide')} role="dialog" aria-modal="true">
        {children}
      </aside>
    </>
  );
}

export function DrawerClose({ closeHref }: { closeHref: string }) {
  const router = useRouter();
  return <IconButton icon="close" title="Close" onClick={() => router.push(closeHref, { scroll: false })} />;
}

/* ----------------------------------------------------------------- forms -- */

export type FieldSpec = {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'number' | 'money' | 'date' | 'datetime' | 'textarea' | 'select' | 'multiselect' | 'checkbox' | 'url' | 'tags' | 'password' | 'file' | 'hidden' | 'json';
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  full?: boolean;
  step?: string;
  min?: number;
  max?: number;
  accept?: string;
  rows?: number;
};

type Values = Record<string, unknown>;

function toInput(f: FieldSpec, v: unknown): unknown {
  if (v == null) return f.type === 'checkbox' ? false : f.type === 'multiselect' ? [] : '';
  if (f.type === 'money') return typeof v === 'number' ? String(v / 100) : String(v);
  if (f.type === 'tags') return Array.isArray(v) ? v.join(', ') : String(v);
  if (f.type === 'json') return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  if (f.type === 'date' && typeof v === 'string') return v.slice(0, 10);
  if (f.type === 'datetime' && typeof v === 'string') return v.slice(0, 16);
  return v;
}

function fromInput(f: FieldSpec, v: unknown): unknown {
  switch (f.type) {
    case 'number':
      return v === '' || v == null ? null : Number(v);
    case 'money':
      return v === '' || v == null ? null : Math.round(Number(v) * 100);
    case 'tags':
      return String(v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    case 'checkbox':
      return Boolean(v);
    case 'multiselect':
      return Array.isArray(v) ? v : [];
    case 'json':
      try {
        return v ? JSON.parse(String(v)) : null;
      } catch {
        return v;
      }
    case 'datetime':
      return v ? new Date(String(v)).toISOString() : null;
    default:
      return v === '' ? null : v;
  }
}

export function FieldInput({ f, value, onChange, error }: { f: FieldSpec; value: unknown; onChange: (v: unknown) => void; error?: string }) {
  const common = { id: `f-${f.name}`, name: f.name, 'aria-invalid': error ? true : undefined, required: f.required, placeholder: f.placeholder };
  if (f.type === 'hidden') return null;
  let control: ReactNode;
  switch (f.type) {
    case 'textarea':
    case 'json':
      control = <textarea {...common} className="lc-textarea" rows={f.rows ?? (f.type === 'json' ? 8 : 4)} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={f.type === 'json' ? { fontFamily: 'var(--lc-font-mono)', fontSize: 12 } : undefined} />;
      break;
    case 'select':
      control = (
        <select {...common} className="lc-select" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {!f.required && <option value="">—</option>}
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'multiselect': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div className="lc-row" style={{ gap: '6px 14px' }}>
          {f.options?.map((o) => (
            <label key={o.value} className="lc-check">
              <input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'checkbox':
      return (
        <label className="lc-check" style={{ gridColumn: f.full ? '1 / -1' : undefined }}>
          <input type="checkbox" name={f.name} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {f.label}
          {f.hint && <span className="lc-field-hint">{f.hint}</span>}
        </label>
      );
    case 'file':
      control = <input {...common} type="file" accept={f.accept} className="lc-input" style={{ paddingTop: 8 }} onChange={(e) => onChange(e.target.files?.[0] ?? null)} />;
      break;
    default:
      control = (
        <input
          {...common}
          className="lc-input"
          type={f.type === 'money' ? 'number' : f.type === 'tags' ? 'text' : f.type === 'datetime' ? 'datetime-local' : (f.type ?? 'text')}
          step={f.type === 'money' ? '0.01' : f.step}
          min={f.min}
          max={f.max}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <label className="lc-field" htmlFor={`f-${f.name}`} style={{ gridColumn: f.full || f.type === 'textarea' || f.type === 'json' ? '1 / -1' : undefined }}>
      <span className="lc-field-label">{f.label}</span>
      {control}
      {error ? <span className="lc-field-error">{error}</span> : f.hint && <span className="lc-field-hint">{f.hint}</span>}
    </label>
  );
}

export type EntityFormProps = {
  fields: FieldSpec[];
  endpoint: string;
  method?: 'POST' | 'PATCH' | 'PUT';
  initial?: Values;
  /** Merged into the submitted body (e.g. a parent id). */
  extra?: Values;
  submitLabel?: string;
  /** Path to navigate to on success; `{id}` etc. are filled from the response. */
  redirectTo?: string;
  success?: string;
  multipart?: boolean;
  columns?: 1 | 2;
  onDone?: () => void;
  cancel?: () => void;
};

/** Declarative form posting JSON (or multipart) to an API route, with server-side field errors. */
export function EntityForm({ fields, endpoint, method = 'POST', initial = {}, extra, submitLabel = 'Save', redirectTo, success = 'Saved', multipart, columns = 2, onDone, cancel }: EntityFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState<Values>(() => Object.fromEntries(fields.map((f) => [f.name, toInput(f, initial[f.name])])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      let res: Values;
      if (multipart) {
        const form = new FormData();
        for (const f of fields) {
          const v = values[f.name];
          if (f.type === 'file') {
            if (v) form.append(f.name, v as File);
          } else {
            const conv = fromInput(f, v);
            if (conv != null) form.append(f.name, typeof conv === 'object' ? JSON.stringify(conv) : String(conv));
          }
        }
        for (const [k, v] of Object.entries(extra ?? {})) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        res = await api<Values>(fill(endpoint, { ...extra, ...values }), { method, form });
      } else {
        const body: Values = { ...extra };
        for (const f of fields) body[f.name] = fromInput(f, values[f.name]);
        // `{field}` in the endpoint is filled from the form, e.g. /agents/{agentId}/run.
        res = await api<Values>(fill(endpoint, { ...extra, ...values }), { method, body });
      }
      if (success) toast(success);
      onDone?.();
      if (redirectTo) router.push(fill(redirectTo, res ?? {}));
      else router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.details && 'fieldErrors' in err.details) {
        const fe = (err.details.fieldErrors ?? {}) as Record<string, string[]>;
        setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, v[0]])));
        setFormError((err.details.formErrors as string[] | undefined)?.[0] ?? (Object.keys(fe).length ? null : err.message));
      } else {
        setFormError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="lc-stack" style={{ gap: 18 }} noValidate>
      <div className={cx('lc-form-grid', columns === 1 && 'lc-form-grid--1')}>
        {fields.map((f) => (
          <FieldInput key={f.name} f={f} value={values[f.name]} error={errors[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
        ))}
      </div>
      {formError && <div className="lc-field-error">{formError}</div>}
      <div className="lc-form-actions">
        {cancel && <Button label="Cancel" onClick={cancel} />}
        <Button type="submit" variant="primary" label={submitLabel} loading={busy} />
      </div>
    </form>
  );
}

/** A trigger button that opens an EntityForm in a modal. */
export function FormModal({ title, description, trigger, wide, ...form }: EntityFormProps & { title: string; description?: string; trigger: ButtonProps; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button {...trigger} onClick={() => setOpen(true)} />
      <Modal open={open} onClose={() => setOpen(false)} title={title} description={description} wide={wide}>
        {open && <EntityForm {...form} onDone={() => setOpen(false)} cancel={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

/** Settings-style fields that save on their own (design: "Changes save automatically"). */
export function AutoSaveFields({ endpoint, fields, initial, method = 'PATCH' }: { endpoint: string; fields: FieldSpec[]; initial: Values; method?: string }) {
  const toast = useToast();
  const router = useRouter();
  const [values, setValues] = useState<Values>(() => Object.fromEntries(fields.map((f) => [f.name, toInput(f, initial[f.name])])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useDebouncedCallback(async (name: string, raw: unknown) => {
    const f = fields.find((x) => x.name === name)!;
    try {
      await api(endpoint, { method, body: { [name]: fromInput(f, raw) } });
      setErrors((e) => ({ ...e, [name]: '' }));
      toast(`${f.label.charAt(0)}${f.label.slice(1).toLowerCase()} saved`);
      router.refresh();
    } catch (err) {
      const fe = err instanceof ApiError && err.details && 'fieldErrors' in err.details ? (err.details.fieldErrors as Record<string, string[]>)[name]?.[0] : null;
      setErrors((e) => ({ ...e, [name]: fe ?? (err as Error).message }));
    }
  }, 700);
  return (
    <div className="lc-form-grid">
      {fields.map((f) => (
        <FieldInput
          key={f.name}
          f={f}
          value={values[f.name]}
          error={errors[f.name] || undefined}
          onChange={(v) => {
            setValues((s) => ({ ...s, [f.name]: v }));
            save(f.name, v);
          }}
        />
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, disabled, title }: { on: boolean; onChange: (next: boolean) => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} title={title} className={cx('lc-toggle', on && 'is-on')} onClick={() => onChange(!on)} disabled={disabled}>
      <span />
    </button>
  );
}

/** A switch bound to an API field. */
export function ApiToggle({ endpoint, field, on, method = 'PATCH', title, disabled }: { endpoint: string; field: string; on: boolean; method?: string; title?: string; disabled?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = useState(on);
  useEffect(() => setValue(on), [on]);
  return (
    <Toggle
      on={value}
      title={title}
      disabled={disabled}
      onChange={async (next) => {
        setValue(next);
        try {
          await api(endpoint, { method, body: { [field]: next } });
          router.refresh();
        } catch (e) {
          setValue(!next);
          toast((e as Error).message, 'error');
        }
      }}
    />
  );
}

/* --------------------------------------------------------- url filters -- */

function useSetQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      next.delete('page');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, params],
  );
}

export function SearchInput({ param = 'q', placeholder = 'Search', width }: { param?: string; placeholder?: string; width?: number }) {
  const params = useSearchParams();
  const setQuery = useSetQuery();
  const [value, setValue] = useState(params.get(param) ?? '');
  const push = useDebouncedCallback((v: string) => setQuery(param, v.trim() || null), 300);
  return (
    <label className="lc-search" style={width ? { width } : undefined}>
      <Icon name="search" />
      <input
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          push(e.target.value);
        }}
      />
    </label>
  );
}

export function FilterSelect({ param, options, allLabel = 'All', minWidth = 150 }: { param: string; options: Array<{ value: string; label: string }>; allLabel?: string; minWidth?: number }) {
  const params = useSearchParams();
  const setQuery = useSetQuery();
  return (
    <select className="lc-select" style={{ width: 'auto', minWidth }} value={params.get(param) ?? ''} onChange={(e) => setQuery(param, e.target.value || null)} aria-label={allLabel}>
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/* --------------------------------------------------------------- upload -- */

/** Drag-and-drop or click to upload one or more files to a multipart endpoint. */
export function UploadZone({ endpoint, field = 'file', extra, label = 'Drop files here or click to upload', accept, multiple = true, redirectTo, compact }: { endpoint: string; field?: string; extra?: Values; label?: string; accept?: string; multiple?: boolean; redirectTo?: string; compact?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(0);

  const upload = async (list: FileList | File[]) => {
    const filesArr = Array.from(list);
    setBusy(filesArr.length);
    let last: Values | null = null;
    for (const file of filesArr) {
      const form = new FormData();
      form.append(field, file);
      for (const [k, v] of Object.entries(extra ?? {})) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      try {
        last = await api<Values>(endpoint, { method: 'POST', form });
        toast(`Uploaded ${file.name}`);
      } catch (e) {
        toast(`${file.name}: ${(e as Error).message}`, 'error');
      }
      setBusy((n) => n - 1);
    }
    if (redirectTo && last && filesArr.length === 1) router.push(fill(redirectTo, last));
    else router.refresh();
  };

  return (
    <div
      className={cx('lc-dropzone', over && 'is-over')}
      style={compact ? { padding: '12px 14px' } : undefined}
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
      }}
      role="button"
      tabIndex={0}
    >
      <input ref={input} type="file" hidden multiple={multiple} accept={accept} onChange={(e) => e.target.files && upload(e.target.files)} />
      {busy > 0 ? (
        <span className="lc-row" style={{ justifyContent: 'center' }}>
          <Spinner /> Uploading {busy} file{busy === 1 ? '' : 's'}…
        </span>
      ) : (
        <span className="lc-row" style={{ justifyContent: 'center' }}>
          <Icon name="upload" size={18} />
          {label}
        </span>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- kanban -- */

export type KanbanCard = { id: string; stage: string; title: string; sub?: string; meta?: string[]; tone?: 'red' | 'blue'; href?: string };

/** Drag cards between stages; each move PATCHes `moveEndpoint` (with `{id}`). */
export function Kanban({ columns, cards, moveEndpoint }: { columns: Array<{ id: string; name: string }>; cards: KanbanCard[]; moveEndpoint: string }) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(cards);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  useEffect(() => setItems(cards), [cards]);

  const byStage = useMemo(() => Object.fromEntries(columns.map((c) => [c.id, items.filter((i) => i.stage === c.id)])), [columns, items]);

  const move = async (id: string, stage: string, position: number) => {
    const prev = items;
    setItems((list) => list.map((c) => (c.id === id ? { ...c, stage } : c)));
    try {
      await api(fill(moveEndpoint, { id }), { method: 'PATCH', body: { stage, position } });
      router.refresh();
    } catch (e) {
      setItems(prev);
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="lc-kanban">
      {columns.map((col) => (
        <div
          key={col.id}
          className={cx('lc-kanban-col', overCol === col.id && 'is-over')}
          onDragOver={(e) => {
            e.preventDefault();
            setOverCol(col.id);
          }}
          onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
          onDrop={(e) => {
            e.preventDefault();
            setOverCol(null);
            const id = e.dataTransfer.getData('text/plain');
            if (id) void move(id, col.id, byStage[col.id]?.length ?? 0);
          }}
        >
          <div className="lc-kanban-head">
            <span style={{ fontSize: 13, fontWeight: 600 }}>{col.name}</span>
            <span className="lc-mono lc-muted" style={{ fontSize: 11 }}>
              {byStage[col.id]?.length ?? 0}
            </span>
          </div>
          <div className="lc-kanban-cards">
            {(byStage[col.id] ?? []).map((card) => (
              <div
                key={card.id}
                className={cx('lc-kanban-card', dragId === card.id && 'is-dragging')}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', card.id);
                  setDragId(card.id);
                }}
                onDragEnd={() => setDragId(null)}
                onClick={() => card.href && router.push(card.href, { scroll: false })}
              >
                <span className="lc-kanban-card-title">{card.title}</span>
                {card.sub && <span className="lc-muted">{card.sub}</span>}
                {card.meta && card.meta.length > 0 && (
                  <span className="lc-row" style={{ gap: 6 }}>
                    {card.meta.map((m) => (
                      <span key={m} className={cx('lc-chip', card.tone === 'red' && 'lc-chip--red', card.tone === 'blue' && 'lc-chip--blue')}>
                        {m}
                      </span>
                    ))}
                  </span>
                )}
                <select
                  className="lc-sr-only"
                  aria-label={`Move ${card.title}`}
                  value={card.stage}
                  onChange={(e) => void move(card.id, e.target.value, 0)}
                  onClick={(e) => e.stopPropagation()}
                >
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Polls a job-status endpoint until it settles, then refreshes the page. */
export function PollUntilDone({ endpoint, done, intervalMs = 1500, field = 'status' }: { endpoint: string; done: string[]; intervalMs?: number; field?: string }) {
  const router = useRouter();
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const res = await api<Record<string, unknown>>(endpoint);
        if (done.includes(String(res?.[field]))) {
          router.refresh();
          return;
        }
      } catch {
        /* keep polling */
      }
      setTimeout(tick, intervalMs);
    };
    const t = setTimeout(tick, intervalMs);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [endpoint, done, intervalMs, field, router]);
  return null;
}
