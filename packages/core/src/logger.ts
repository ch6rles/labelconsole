import pino from 'pino';

/**
 * Structured logs. Secret-shaped fields are redacted at the logger so a stray
 * `log.info({ credential })` can never write a key to disk.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: process.env.LC_PROCESS ?? 'web' },
  redact: {
    paths: [
      '*.password', '*.passwordHash', '*.secret', '*.apiKey', '*.api_key', '*.token', '*.accessToken',
      '*.refreshToken', '*.authorization', '*.ciphertext', 'secret', 'password', 'apiKey', 'token',
      'headers.authorization', 'headers.cookie', 'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
