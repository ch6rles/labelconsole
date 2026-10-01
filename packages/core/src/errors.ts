export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Sign in required') {
    super(401, 'unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that', details?: unknown) {
    super(403, 'forbidden', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Resource') {
    super(404, 'not_found', `${what} not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, 'validation_failed', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, 'conflict', message, details);
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = 'Rate limit reached') {
    super(429, 'rate_limited', message, { retryAfterMs });
    this.retryAfterMs = retryAfterMs;
  }
}

export class ModuleDisabledError extends AppError {
  constructor(moduleId: string) {
    super(404, 'module_disabled', `The ${moduleId} module is not enabled for this label`);
  }
}

/** An error from a third-party API. `transient` drives retry decisions. */
export class ProviderError extends AppError {
  readonly provider: string;
  readonly transient: boolean;
  readonly upstreamStatus?: number;
  readonly retryAfterMs?: number;

  constructor(provider: string, message: string, opts: { status?: number; transient?: boolean; retryAfterMs?: number } = {}) {
    super(502, 'provider_error', `${provider}: ${message}`);
    this.provider = provider;
    this.upstreamStatus = opts.status;
    this.transient = opts.transient ?? (opts.status === undefined || opts.status === 429 || opts.status >= 500);
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isTransient(err: unknown): boolean {
  if (err instanceof ProviderError) return err.transient;
  if (err instanceof RateLimitedError) return true;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true;
  const code = (err as { code?: string } | null)?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN';
}
