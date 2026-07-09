import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, generateTotpSecret,
  isEncrypted, otpauthUri, passwordExpiredForRole, totpCode, validatePassword, verifyTotp,
} from '../src/security/crypto.ts';
import { mapGroupsToRole } from '../src/security/sso.ts';
import { hashPassword, verifyPassword } from '../src/web/auth.ts';

describe('password policy', () => {
  it('requires 12+ chars and 3 of 4 character classes', () => {
    assert.equal(validatePassword('Str0ng!Passw0rd').ok, true);
    assert.equal(validatePassword('nouppercase1!aa').ok, true);   // lower+digit+symbol
    assert.equal(validatePassword('Short1!').ok, false);          // too short
    assert.equal(validatePassword('alllowercaseonly').ok, false); // one class
    assert.equal(validatePassword('almostgood12').ok, false);     // two classes
    const weak = validatePassword('abc');
    assert.ok(weak.errors.length >= 1);
  });

  it('90-day rotation applies to admin roles only', () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    const fresh = new Date(Date.now() - 10 * 86_400_000);
    assert.equal(passwordExpiredForRole('tenant_admin', old), true);
    assert.equal(passwordExpiredForRole('client_admin', old), true);
    assert.equal(passwordExpiredForRole('tenant_admin', fresh), false);
    assert.equal(passwordExpiredForRole('biller', old), false);   // non-admin exempt
    assert.equal(passwordExpiredForRole('tenant_admin', null), true);
  });

  it('scrypt hashes verify and never store plaintext', () => {
    const h = hashPassword('Str0ng!Passw0rd');
    assert.ok(!h.includes('Str0ng'));
    assert.equal(verifyPassword('Str0ng!Passw0rd', h), true);
    assert.equal(verifyPassword('wrong', h), false);
  });
});

describe('secret encryption (AES-256-GCM)', () => {
  it('round-trips and never stores plaintext', () => {
    const enc = encryptSecret('sftp-password-123');
    assert.ok(isEncrypted(enc));
    assert.ok(!enc.includes('sftp-password'));
    assert.equal(decryptSecret(enc), 'sftp-password-123');
  });

  it('unique IVs: same plaintext encrypts differently', () => {
    assert.notEqual(encryptSecret('same'), encryptSecret('same'));
  });

  it('tampered ciphertext fails authentication', () => {
    const enc = encryptSecret('secret');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered!').toString('base64');
    assert.throws(() => decryptSecret(parts.join(':')));
  });
});

describe('TOTP (RFC 6238)', () => {
  it('base32 round-trips', () => {
    const buf = Buffer.from('hello totp world!');
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  });

  it('matches the RFC 6238 style vectors', () => {
    // secret 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' = ASCII '12345678901234567890'
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // T=59s -> counter 1 -> known SHA-1 value 94287082 -> 6 digits 287082
    assert.equal(totpCode(secret, 59_000), '287082');
    assert.equal(totpCode(secret, 1111111109_000), '081804');
  });

  it('verifies within the drift window and rejects outside it', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpCode(secret, now);
    assert.equal(verifyTotp(secret, code, now), true);
    assert.equal(verifyTotp(secret, code, now + 30_000), true);   // one step late
    assert.equal(verifyTotp(secret, code, now + 120_000), false); // too late
    assert.equal(verifyTotp(secret, '000000', now), code === '000000');
    assert.equal(verifyTotp(secret, 'abc', now), false);
  });

  it('builds a provisioning URI', () => {
    const uri = otpauthUri('ABC234', 'user@example.com');
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /secret=ABC234/);
  });
});

describe('SSO group -> role mapping', () => {
  const mappings = [
    { group: 'rcm-admins', role: 'tenant_admin' },
    { group: 'rcm-billers', role: 'biller' },
    { group: 'RCM-Collectors', role: 'collector' },
  ];

  it('maps matching groups, case-insensitively', () => {
    assert.equal(mapGroupsToRole(mappings, ['rcm-billers'], 'viewer'), 'biller');
    assert.equal(mapGroupsToRole(mappings, ['rcm-collectors'], 'viewer'), 'collector');
  });

  it('most privileged role wins on multiple matches', () => {
    assert.equal(mapGroupsToRole(mappings, ['rcm-billers', 'rcm-admins'], 'viewer'), 'tenant_admin');
  });

  it('falls back to the default role, sanitized', () => {
    assert.equal(mapGroupsToRole(mappings, ['unrelated'], 'viewer'), 'viewer');
    assert.equal(mapGroupsToRole(mappings, [], 'not-a-role'), 'viewer');
  });

  it('ignores mappings to invalid roles', () => {
    assert.equal(mapGroupsToRole([{ group: 'x', role: 'root' }], ['x'], 'viewer'), 'viewer');
  });
});
