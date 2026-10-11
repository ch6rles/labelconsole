import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/** DER prefix that wraps a raw 32-byte Ed25519 public key as SubjectPublicKeyInfo. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const keys = new Map<string, KeyObject>();

export const isPublicKeyHex = (s: string) => /^[0-9a-f]{64}$/i.test(s);
export const isSnowflake = (s: string) => /^\d{15,22}$/.test(s);

function keyFor(publicKeyHex: string) {
  const hex = publicKeyHex.toLowerCase();
  let key = keys.get(hex);
  if (!key) {
    key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
    keys.set(hex, key);
  }
  return key;
}

/**
 * Discord signs every interaction: Ed25519 over the timestamp header followed
 * by the raw body bytes, checked against the application's public key.
 */
export function verifyDiscordSignature(publicKeyHex: string, signatureHex: string, timestamp: string, body: Buffer): boolean {
  if (!isPublicKeyHex(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{1,13}$/.test(timestamp)) return false;
  try {
    return verify(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), body]), keyFor(publicKeyHex), Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
