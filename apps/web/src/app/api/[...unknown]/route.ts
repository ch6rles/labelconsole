import { json } from '@/server/http';

/** Any /api path without a route: a JSON 404, rather than falling through to the console pages and their sign-in redirect. */
const notFound = () => json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404);

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
