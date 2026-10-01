import { createRedis, redis } from '@labelconsole/core/redis';

/**
 * Control messages for running agent runs. Pause and stop are written to the
 * database and honoured between steps; `kill` additionally aborts whatever
 * the run is doing right now (an in-flight model or tool call) in whichever
 * worker process holds it.
 */
const CHANNEL = 'lc:agents:control';
const g = globalThis as unknown as { __lcRunAborts?: Map<string, AbortController>; __lcControlSub?: boolean };
const aborts: Map<string, AbortController> = (g.__lcRunAborts ??= new Map());

export async function sendControl(runId: string, action: 'kill') {
  await redis().publish(CHANNEL, JSON.stringify({ runId, action }));
}

/** Register a run executing in this process; returns its abort signal and a cleanup. */
export function trackRun(runId: string) {
  ensureSubscribed();
  const ac = new AbortController();
  aborts.set(runId, ac);
  return { signal: ac.signal, done: () => aborts.delete(runId) };
}

function ensureSubscribed() {
  if (g.__lcControlSub) return;
  g.__lcControlSub = true;
  const sub = createRedis();
  void sub.subscribe(CHANNEL);
  sub.on('message', (_ch, msg) => {
    try {
      const { runId, action } = JSON.parse(msg) as { runId: string; action: string };
      if (action === 'kill') aborts.get(runId)?.abort(new Error('Stopped by a person'));
    } catch {
      /* ignore malformed */
    }
  });
}
