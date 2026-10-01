import { describe, expect, it } from 'vitest';
import { closeQueues, queue } from './queue';

describe('closeQueues', () => {
  it('quits the Redis connection each queue was given, so scripts and workers can exit', async () => {
    const q = queue('events');
    const client = await q.client;
    await q.getJobCounts();
    expect(client.status).toBe('ready');
    const ended = new Promise<void>((resolve) => client.once('end', () => resolve()));
    await closeQueues();
    await ended; // never resolves (test times out) if the connection is left open
    expect(client.status).toBe('end');
    // A queue asked for afterwards gets a fresh connection.
    const again = queue('events');
    expect(again).not.toBe(q);
    await again.getJobCounts();
    await closeQueues();
  });
});
