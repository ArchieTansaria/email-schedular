import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface GoogleOAuthProvider {
  generateAuthorizationUrl(input: { state: string; nonce: string }): string;
  exchangeCode(input: { code: string; expectedNonce: string }): Promise<GoogleIdentity>;
}

export class GoogleIdentityError extends Error {
  constructor(message = 'Google identity could not be verified') {
    super(message);
    this.name = 'GoogleIdentityError';
  }
}

export class GoogleOAuthClient implements GoogleOAuthProvider {
  readonly #client: OAuth2Client;
  readonly #clientId: string;

  constructor(options: { clientId: string; clientSecret: string; redirectUri: string }) {
    this.#clientId = options.clientId;
    this.#client = new OAuth2Client({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri: options.redirectUri,
    });
  }

  generateAuthorizationUrl(input: { state: string; nonce: string }): string {
    return this.#client.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state: input.state,
      nonce: input.nonce,
      prompt: 'select_account',
    });
  }

  async exchangeCode(input: { code: string; expectedNonce: string }): Promise<GoogleIdentity> {
    const { tokens } = await this.#client.getToken(input.code);
    if (!tokens.id_token) throw new GoogleIdentityError('Google did not return an ID token');

    const ticket = await this.#client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.#clientId,
    });
    const payload = ticket.getPayload();
    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true ||
      payload.nonce !== input.expectedNonce
    ) {
      throw new GoogleIdentityError();
    }

    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name?.trim() || payload.email,
      avatarUrl: payload.picture ?? null,
    };
  }
}
