import { z } from 'zod';
import { normalizeIsrc, normalizeUpc } from '../metadata/input';

export const upcField = z
  .string()
  .trim()
  .transform((s, ctx) => {
    if (!s) return null;
    const n = normalizeUpc(s);
    if (!n) ctx.addIssue({ code: 'custom', message: 'Not a valid UPC/EAN (check digit failed)' });
    return n;
  })
  .nullable();

export const isrcField = z
  .string()
  .trim()
  .transform((s, ctx) => {
    if (!s) return null;
    const n = normalizeIsrc(s);
    if (!n) ctx.addIssue({ code: 'custom', message: 'Not a valid ISRC (CC-XXX-YY-NNNNN)' });
    return n;
  })
  .nullable();

export const formatIsrc = (isrc: string | null | undefined) => (isrc ? `${isrc.slice(0, 2)}-${isrc.slice(2, 5)}-${isrc.slice(5, 7)}-${isrc.slice(7)}` : null);

export const today = () => new Date().toISOString().slice(0, 10);
