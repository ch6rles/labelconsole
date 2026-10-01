import { NextResponse, type NextRequest } from 'next/server';

/** Expose the requested path to server components (used for post-login redirects). */
export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set('x-lc-path', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/((?!api|_next|favicon.ico).*)'] };
