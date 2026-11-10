import { describe, expect, it } from 'vitest';
import { ConnectionsService } from '../src/management/connections.service';

/** Account-mail status follows MAIL_PROVIDER like the runtime transport. Local configuration only, no network. */
const row = async (env: NodeJS.ProcessEnv) =>
  (await new ConnectionsService(env).inspect()).connections.find(connection => connection.id === 'account-email')!;
const web = { WEB_URL: 'http://localhost:4202' };

describe('account-email connection status', () => {
  it('reports SMTP as before (default provider)', async () => {
    expect(await row({ ...web, SMTP_HOST: 'mail.example.invalid', SMTP_FROM: 'app@example.invalid' })).toMatchObject({ status: 'configured', mode: 'smtp', missing: [] });
    expect(await row({ ...web, SMTP_FROM: 'app@example.invalid' })).toMatchObject({ missing: ['SMTP_HOST'] });
  });
  it('reports Resend as configured without any SMTP host', async () => {
    const resend = await row({ ...web, MAIL_PROVIDER: 'resend', SMTP_FROM: 'app@example.invalid', MAIL_RESEND_API_KEY: 're_synthetic' });
    expect(resend.missing).toEqual([]);
    expect(resend.mode === 'resend' || resend.status === 'missing-sdk').toBe(true);
    expect(JSON.stringify(resend)).not.toContain('re_synthetic');
    expect(await row({ ...web, MAIL_PROVIDER: 'resend', SMTP_FROM: 'app@example.invalid' })).toMatchObject({ missing: ['MAIL_RESEND_API_KEY'] });
  });
  it('marks an unknown provider invalid', async () => {
    expect(await row({ ...web, MAIL_PROVIDER: 'carrier-pigeon', SMTP_HOST: 'mail.example.invalid', SMTP_FROM: 'app@example.invalid' })).toMatchObject({ status: 'invalid' });
  });
});
