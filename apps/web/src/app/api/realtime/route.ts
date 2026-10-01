import { realtimeHub, type RealtimeMessage } from '@labelconsole/core/realtime';
import { sessionFromRequest } from '@/server/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Server-Sent Events gateway. Subscribes to the org's Redis channel and
 * forwards events the member may see (per-user and per-permission filtering).
 */
export async function GET(req: Request) {
  const s = await sessionFromRequest(req);
  if (!s) return new Response('Unauthorized', { status: 401 });
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const unsubscribe = realtimeHub.subscribe(s.org.id, (msg: RealtimeMessage) => {
        if (msg.userId && msg.userId !== s.user.id) return;
        if (msg.permission && !s.permissions.has(msg.permission)) return;
        write(`data: ${JSON.stringify(msg)}\n\n`);
      });
      const ping = setInterval(() => write(': ping\n\n'), 25_000);
      write('retry: 3000\n\n');
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}
