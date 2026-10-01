import { describe, expect, it } from 'vitest';

import { SecretCipher } from './encryption.js';

describe('SecretCipher', () => {
  const key = 'test-encryption-key-that-is-at-least-32-characters';

  it('round trips a secret without embedding plaintext', () => {
    const cipher = new SecretCipher(key);
    const encrypted = cipher.encrypt('https://hooks.slack.com/services/secret');
    expect(encrypted).not.toContain('hooks.slack.com');
    expect(cipher.decrypt(encrypted)).toBe('https://hooks.slack.com/services/secret');
  });

  it('randomizes repeated encryption of the same plaintext', () => {
    const cipher = new SecretCipher(key);
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('rejects tampering and the wrong key', () => {
    const encrypted = new SecretCipher(key).encrypt('secret');
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('a') ? 'b' : 'a'}`;
    expect(() => new SecretCipher(key).decrypt(tampered)).toThrow();
    expect(() =>
      new SecretCipher('a-different-encryption-key-at-least-32-chars').decrypt(encrypted),
    ).toThrow();
  });
});
