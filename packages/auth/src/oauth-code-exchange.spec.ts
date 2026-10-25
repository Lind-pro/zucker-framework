import { describe, expect, it, vi } from 'vitest';
import {
  exchangeGoogleOAuthCode,
  exchangeGitHubOAuthCode,
  OAuthCodeExchangeError,
} from './oauth-code-exchange';

const options = {
  code: 'synthetic-code',
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('OAuth authorization code exchange', () => {
  it('exchanges Google form data and returns the consumer-compatible profile', async () => {
    const signal = new AbortController().signal;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' }),
      )
      .mockResolvedValueOnce(
        json({
          id: 'google-id',
          email: 'user@example.test',
          name: 'Synthetic User',
          given_name: 'Synthetic',
          family_name: 'User',
          picture: 'https://images.example.test/avatar',
        }),
      );
    const profile = await exchangeGoogleOAuthCode({
      ...options,
      redirectUri: 'https://app.example.test/callback',
      signal,
      fetcher,
    });
    const request = fetcher.mock.calls[0][1];
    expect(request?.method).toBe('POST');
    expect(request?.body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(request?.body as URLSearchParams)).toEqual({
      code: 'synthetic-code',
      client_id: 'synthetic-client',
      client_secret: 'synthetic-secret',
      redirect_uri: 'https://app.example.test/callback',
      grant_type: 'authorization_code',
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, 'https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer synthetic-access' },
      signal,
    });
    expect(profile).toEqual({
      provider: 'google',
      id: 'google-id',
      email: 'user@example.test',
      displayName: 'Synthetic User',
      firstName: 'Synthetic',
      lastName: 'User',
      picture: 'https://images.example.test/avatar',
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
    });
  });

  it('avoids the GitHub email request when public email is present', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: 'synthetic-access' }))
      .mockResolvedValueOnce(
        json({ id: 42, email: 'public@example.test', login: 'handle', name: null }),
      );
    const profile = await exchangeGitHubOAuthCode({ ...options, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      client_id: 'synthetic-client',
      client_secret: 'synthetic-secret',
      code: 'synthetic-code',
    });
    expect(profile).toMatchObject({
      provider: 'github',
      id: '42',
      email: 'public@example.test',
      displayName: 'handle',
      username: 'handle',
    });
  });

  it('keeps primary-email selection separate from account verification policy', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: 'synthetic-access' }))
      .mockResolvedValueOnce(json({ id: 42, email: null, login: 'handle' }))
      .mockResolvedValueOnce(
        json([
          { email: 'secondary@example.test', primary: false, verified: true },
          { email: 'primary@example.test', primary: true, verified: false },
        ]),
      );
    const profile = await exchangeGitHubOAuthCode({ ...options, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(profile.email).toBe('primary@example.test');
    expect(profile).not.toHaveProperty('emailVerified');
  });

  it('rejects HTTP/token/profile failures without returning provider response bodies', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: 'synthetic-private-provider-body' }, 400));
    const custom = new Error('localized token error');
    const errorFactory = vi.fn((_failure: OAuthCodeExchangeError) => custom);
    await expect(exchangeGitHubOAuthCode({ ...options, fetcher, errorFactory })).rejects.toBe(
      custom,
    );
    expect(errorFactory).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github', stage: 'token', status: 400 }),
    );
    expect(String(errorFactory.mock.calls[0][0])).not.toContain('synthetic-private-provider-body');
    fetcher
      .mockReset()
      .mockResolvedValueOnce(json({ access_token: 'synthetic-access' }))
      .mockResolvedValueOnce(json({ login: 'missing-id' }));
    await expect(exchangeGitHubOAuthCode({ ...options, fetcher })).rejects.toBeInstanceOf(
      OAuthCodeExchangeError,
    );
  });

  it('preserves an explicit cancellation failure without converting it into a provider error', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new Error('cancelled');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(
      exchangeGitHubOAuthCode({ ...options, signal: controller.signal, fetcher }),
    ).rejects.toBe(error);
  });
  it('sends PKCE and redirect URI and obtains GitHub verified email evidence even for a public email', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: 'synthetic-access' }))
      .mockResolvedValueOnce(json({ id: 42, login: 'handle', email: 'public@example.test' }))
      .mockResolvedValueOnce(json([{ email: 'public@example.test', primary: true, verified: false },
        { email: 'verified@example.test', primary: false, verified: true }]));
    const profile = await exchangeGitHubOAuthCode({ ...options, redirectUri: 'https://app.example.test/callback', codeVerifier: 'synthetic-pkce', includeEmailVerification: true, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ code_verifier: 'synthetic-pkce', redirect_uri: 'https://app.example.test/callback' });
    expect(profile).toMatchObject({ email: 'verified@example.test', emailVerified: true });
  });
  it('projects Google ID-token/verified-email evidence and sends the original PKCE verifier', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: 'synthetic-access', id_token: 'synthetic-id-token' }))
      .mockResolvedValueOnce(json({ id: 'google-id', email: 'member@example.test', verified_email: true }));
    const profile = await exchangeGoogleOAuthCode({ ...options, redirectUri: 'https://app.example.test/callback', codeVerifier: 'synthetic-pkce', fetcher });
    expect((fetcher.mock.calls[0][1]?.body as URLSearchParams).get('code_verifier')).toBe('synthetic-pkce');
    expect(profile).toMatchObject({ idToken: 'synthetic-id-token', emailVerified: true });
  });

});
