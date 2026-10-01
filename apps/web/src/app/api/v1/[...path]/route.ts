import { createRouter } from '@labelconsole/core/router';
import { serverModules } from '@/server/modules';
import { platformRoutes } from '@/server/platform-routes';
import { sessionFromRequest } from '@/server/session';

export const dynamic = 'force-dynamic';

const handle = createRouter([...platformRoutes, ...serverModules.flatMap((m) => m.routes ?? [])], { resolveSession: sessionFromRequest });

type Ctx = { params: Promise<{ path: string[] }> };
const dispatch = async (req: Request, { params }: Ctx) => handle(req, (await params).path);

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
