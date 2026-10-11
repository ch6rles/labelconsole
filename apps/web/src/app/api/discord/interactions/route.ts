import { handleInteraction } from '@labelconsole/discord/interactions';
import '@/server/modules';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Discord's Interactions Endpoint URL. Not a session route: every request is
 * signed by Discord and checked against the label's Discord app public key.
 */
export async function POST(req: Request) {
  return handleInteraction(req);
}
