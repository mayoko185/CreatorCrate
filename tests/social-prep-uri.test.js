import { describe, expect, it } from 'vitest';
import { digestToken, generateIntentToken, generateMediaToken } from '../src/services/social-prep-tokens.js';
import { buildSocialPrepUri } from '../src/util/social-prep-uri.js';

const intent = 'a'.repeat(43);

describe('Social Preparation capability tokens and URI', () => {
  it('generates opaque 256-bit base64url tokens and only exposes their SHA-256 digest contract', () => {
    const tokens = [generateIntentToken(), generateMediaToken()];
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(digestToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(digestToken(tokens[0])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds a minimal URI and rejects origins or tokens that require normalization', () => {
    const uri = buildSocialPrepUri({ origin: 'https://creatorcrate.test:8443', intent });
    expect(uri).toBe(`creatorcrate-social://prepare?v=1&server=https%3A%2F%2Fcreatorcrate.test%3A8443&intent=${intent}`);
    expect(uri).not.toMatch(/title|body|media|cookie|bearer|credential/i);
    for (const origin of ['https://user:pass@creatorcrate.test', 'https://creatorcrate.test/path', 'https://creatorcrate.test/?q=1', 'https://creatorcrate.test/#hash', 'ftp://creatorcrate.test', 'https://CREATORCRATE.test']) {
      expect(() => buildSocialPrepUri({ origin, intent })).toThrow(TypeError);
    }
    expect(() => buildSocialPrepUri({ origin: 'https://creatorcrate.test', intent: 'short' })).toThrow(TypeError);
  });
});
