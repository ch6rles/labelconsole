'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/*
 * Typed ports of the behaviour support.js gave the prototype: state that
 * survives reloads (the prototype's localStorage `load`/`setItem`), hover and
 * focus styles (moved to CSS), keyboard shortcuts, and disclosure state.
 */

const listeners = new Map<string, Set<() => void>>();

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** useState backed by localStorage, synced across components and tabs, SSR-safe. */
export function usePersistedState<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void, () => void] {
  const fallbackRef = useRef(fallback);
  const cache = useRef<{ raw: string | null; value: T } | null>(null);

  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      const onStorage = (e: StorageEvent) => e.key === key && cb();
      window.addEventListener('storage', onStorage);
      return () => {
        set!.delete(cb);
        window.removeEventListener('storage', onStorage);
      };
    },
    [key],
  );

  const getSnapshot = useCallback(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      raw = null;
    }
    if (cache.current && cache.current.raw === raw) return cache.current.value;
    const value = raw == null ? fallbackRef.current : readStorage(key, fallbackRef.current);
    cache.current = { raw, value };
    return value;
  }, [key]);

  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallbackRef.current);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = readStorage(key, fallbackRef.current);
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage full or blocked: keep in-memory behaviour */
      }
      listeners.get(key)?.forEach((cb) => cb());
    },
    [key],
  );

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    listeners.get(key)?.forEach((cb) => cb());
  }, [key]);

  return [value, set, reset];
}

/** `mod+k` style shortcuts; `mod` is Cmd on macOS and Ctrl elsewhere. */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, opts: { enabled?: boolean } = {}) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (opts.enabled === false) return;
    const parts = combo.toLowerCase().split('+');
    const key = parts[parts.length - 1];
    const needMod = parts.includes('mod');
    const needShift = parts.includes('shift');
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key) return;
      if (needMod && !(e.metaKey || e.ctrlKey)) return;
      if (!needMod && (e.metaKey || e.ctrlKey)) return;
      if (needShift !== e.shiftKey) return;
      ref.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, opts.enabled]);
}

export function useDisclosure(initial = false) {
  const [open, setOpen] = useState(initial);
  return useMemo(() => ({ open, onOpen: () => setOpen(true), onClose: () => setOpen(false), onToggle: () => setOpen((o) => !o), setOpen }), [open]);
}

export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, ms = 250) {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(
    (...args: A) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => ref.current(...args), ms);
    },
    [ms],
  );
}

export function useOnClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) handler();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && handler();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, handler, enabled]);
}

/* ------------------------------------------------------------ realtime -- */

export type RealtimeEvent = { type: string; data: Record<string, unknown>; at?: string; userId?: string };
type Handler = (e: RealtimeEvent) => void;

export type RealtimeBus = { subscribe(type: string, h: Handler): () => void; connected: boolean };

export const RealtimeContext = createContext<RealtimeBus | null>(null);

/** One EventSource for the whole console, with automatic reconnect. */
export function useRealtimeConnection(url = '/api/realtime'): RealtimeBus {
  const handlers = useRef(new Map<string, Set<Handler>>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let closed = false;
    const connect = () => {
      es = new EventSource(url);
      es.onopen = () => {
        attempts = 0;
        setConnected(true);
      };
      es.onmessage = (m) => {
        let evt: RealtimeEvent;
        try {
          evt = JSON.parse(m.data);
        } catch {
          return;
        }
        for (const key of [evt.type, '*', evt.type.split('.').slice(0, 2).join('.') + '.*']) handlers.current.get(key)?.forEach((h) => h(evt));
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (closed) return;
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts++));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [url]);

  return useMemo(
    () => ({
      connected,
      subscribe(type, h) {
        let set = handlers.current.get(type);
        if (!set) handlers.current.set(type, (set = new Set()));
        set.add(h);
        return () => set!.delete(h);
      },
    }),
    [connected],
  );
}

/** Subscribe to realtime events: exact type, `module.entity.*`, or `*`. */
export function useRealtime(type: string, handler: Handler) {
  const bus = useContext(RealtimeContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => bus?.subscribe(type, (e) => ref.current(e)), [bus, type]);
  return bus?.connected ?? false;
}
