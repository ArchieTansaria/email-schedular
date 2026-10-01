import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateAuthUrl = vi.fn();
const getToken = vi.fn();
const verifyIdToken = vi.fn();

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    generateAuthUrl = generateAuthUrl;
    getToken = getToken;
    verifyIdToken = verifyIdToken;
  },
}));

import { GoogleIdentityError, GoogleOAuthClient } from './google-oauth.js';

const client = new GoogleOAuthClient({
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
  redirectUri: 'http://localhost:4000/api/v1/auth/google/callback',
});

beforeEach(() => {
  vi.clearAllMocks();
  generateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth');
  getToken.mockResolvedValue({ tokens: { id_token: 'signed-id-token' } });
  verifyIdToken.mockResolvedValue({
    getPayload: () => ({
      sub: 'google-subject',
      email: 'user@example.test',
      email_verified: true,
      name: 'Example User',
      picture: 'https://example.test/avatar.png',
      nonce: 'expected-nonce',
    }),
  });
});

describe('GoogleOAuthClient', () => {
  it('requests only identity scopes plus state/nonce without offline access', () => {
    client.generateAuthorizationUrl({ state: 'secure-state', nonce: 'secure-nonce' });
    expect(generateAuthUrl).toHaveBeenCalledWith({
      scope: ['openid', 'email', 'profile'],
      state: 'secure-state',
      nonce: 'secure-nonce',
      prompt: 'select_account',
    });
    expect(generateAuthUrl.mock.calls[0]?.[0]).not.toHaveProperty('access_type');
  });

  it('exchanges server-side, verifies the configured audience, and maps signed identity claims', async () => {
    await expect(
      client.exchangeCode({ code: 'authorization-code', expectedNonce: 'expected-nonce' }),
    ).resolves.toEqual({
      sub: 'google-subject',
      email: 'user@example.test',
      name: 'Example User',
      avatarUrl: 'https://example.test/avatar.png',
    });
    expect(getToken).toHaveBeenCalledWith('authorization-code');
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'signed-id-token',
      audience: 'google-client-id',
    });
  });

  it('rejects missing tokens, nonce mismatch, and library verification failures', async () => {
    getToken.mockResolvedValueOnce({ tokens: {} });
    await expect(
      client.exchangeCode({ code: 'code', expectedNonce: 'expected-nonce' }),
    ).rejects.toBeInstanceOf(GoogleIdentityError);

    verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({
        sub: 'google-subject',
        email: 'user@example.test',
        email_verified: true,
        nonce: 'wrong-nonce',
      }),
    });
    await expect(
      client.exchangeCode({ code: 'code', expectedNonce: 'expected-nonce' }),
    ).rejects.toBeInstanceOf(GoogleIdentityError);

    verifyIdToken.mockRejectedValueOnce(new Error('wrong audience or invalid signature'));
    await expect(
      client.exchangeCode({ code: 'code', expectedNonce: 'expected-nonce' }),
    ).rejects.toThrow('wrong audience or invalid signature');
  });
});
