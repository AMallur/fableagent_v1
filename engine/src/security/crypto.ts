// ============================================================================
// Security primitives:
//   * password policy (min 12 chars, complexity, 90-day admin rotation)
//   * AES-256-GCM secret encryption (integration credentials, MFA secrets)
//   * RFC 6238 TOTP (MFA for admin roles) — no external dependencies
// ============================================================================

import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from 'node:crypto';
import { requireSecret } from './secrets.ts';

// ---------------------------------------------------------------------------
// password policy
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_AGE_DAYS = 90;
export const ADMIN_ROLES = new Set(['super_admin', 'tenant_admin', 'client_admin']);

export function validatePassword(password: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`at least ${PASSWORD_MIN_LENGTH} characters required`);
  }
  const classes = [
    [/[a-z]/, 'a lowercase letter'],
    [/[A-Z]/, 'an uppercase letter'],
    [/[0-9]/, 'a digit'],
    [/[^a-zA-Z0-9]/, 'a symbol'],
  ] as const;
  const present = classes.filter(([re]) => re.test(password));
  if (present.length < 3) {
    errors.push('must include at least 3 of: '
      + classes.map(([, label]) => label).join(', '));
  }
  return { ok: errors.length === 0, errors };
}

export function passwordExpiredForRole(
  role: string, passwordChangedAt: Date | string | null,
): boolean {
  if (!ADMIN_ROLES.has(role)) return false;
  if (!passwordChangedAt) return true;   // never set = must rotate
  const changed = new Date(passwordChangedAt).getTime();
  return Date.now() - changed > ADMIN_PASSWORD_MAX_AGE_DAYS * 86_400_000;
}

// ---------------------------------------------------------------------------
// secret encryption at rest (AES-256-GCM)
// Key from DATA_ENCRYPTION_KEY (env or DATA_ENCRYPTION_KEY_FILE). In
// production this throws rather than silently falling back — see
// security/secrets.ts. Call ensureDataEncryptionKeyConfigured() eagerly at
// process startup so a misconfigured deploy fails at boot, not on the first
// SFTP credential save.
// ---------------------------------------------------------------------------

function dataEncryptionKeySource(): string {
  return requireSecret('DATA_ENCRYPTION_KEY', {
    devFallback: 'dev-only-data-key-set-DATA_ENCRYPTION_KEY',
  });
}

export function ensureDataEncryptionKeyConfigured(): void {
  dataEncryptionKeySource();
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(dataEncryptionKeySource()).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [scheme, iv, tag, data] = stored.split(':');
  if (scheme !== 'enc1') throw new Error('unrecognized secret encoding');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export const isEncrypted = (v: string | null | undefined): boolean =>
  !!v && v.startsWith('enc1:');

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 digits, 30s step) + base32
// ---------------------------------------------------------------------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, atMs = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits);
  return String(code).padStart(digits, '0');
}

/** accepts the current step ± window (clock drift) */
export function verifyTotp(secret: string, code: string, atMs = Date.now(), window = 1): boolean {
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (let w = -window; w <= window; w++) {
    if (totpCode(secret, atMs + w * 30_000) === c) return true;
  }
  return false;
}

export function otpauthUri(secret: string, email: string, issuer = 'RCM Recovery'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`
    + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
