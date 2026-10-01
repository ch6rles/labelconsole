'use client';

import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import { useRealtime } from '@labelconsole/ui/hooks';

const WATCHED = new Set(['agents.step.created', 'agents.run.updated', 'agents.approval.updated', 'agents.approval.requested']);

/**
 * Re-render the server page when agent activity arrives over realtime:
 * steps, status changes and approval decisions. Throttled so a fast run
 * doesn't hammer the server. `runId` narrows it to one run (and its children).
 */
export function LiveRefresh({ runId }: { runId?: string }) {
  const router = useRouter();
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useRealtime('*', (e) => {
    if (!WATCHED.has(e.type)) return;
    if (runId && e.data.runId !== runId && e.data.parentRunId !== runId) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      last.current = Date.now();
      router.refresh();
    }, Math.max(0, 1200 - (Date.now() - last.current)));
  });
  return null;
}
