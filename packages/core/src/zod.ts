import { z } from 'zod';

type StripDefault<T> = T extends z.ZodDefault<infer I> ? StripDefault<I> : T extends z.ZodPrefault<infer I> ? StripDefault<I> : T;
type PatchShape<S extends z.ZodRawShape> = { [K in keyof S]: z.ZodOptional<StripDefault<S[K]> extends z.ZodType ? StripDefault<S[K]> : never> };

function stripDefault(t: z.ZodType): z.ZodType {
  let cur: z.ZodType = t;
  while (cur instanceof z.ZodDefault || cur instanceof z.ZodPrefault) cur = cur.unwrap() as z.ZodType;
  return cur;
}

/**
 * The PATCH version of a create schema: every field optional and no defaults.
 * Zod's `.partial()` keeps defaults, so a patch that omits a defaulted field
 * would silently reset it (e.g. a release's status back to "collecting").
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodObject<PatchShape<S>> {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, stripDefault(v as z.ZodType).optional()]));
  return z.object(shape) as unknown as z.ZodObject<PatchShape<S>>;
}
