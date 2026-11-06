// @vitest-environment node
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailEngagementService } from './mail-engagement.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('mail engagement against PostgreSQL', () => {
  const schema = `zucker_mail_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const client = new Client({ connectionString: databaseUrl });
  let service: MailEngagementService;

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE mail_history (
      id text PRIMARY KEY, recipient text NOT NULL, template text, provider text, "messageId" text,
      "userId" text, status text NOT NULL, metadata jsonb, "createdAt" timestamp NOT NULL DEFAULT now())`);
    const rows: Array<[string, string, string, boolean]> = [
      ['1', 'welcome', 'm1', true],
      ['2', 'welcome', 'm2', true],
      ['3', 'welcome', 'm3', true],
      ['4', 'code', 'm4', false],
    ];
    for (const [id, template, messageId, tracked] of rows)
      await client.query(
        `INSERT INTO mail_history (id, recipient, template, provider, "messageId", status, metadata)
         VALUES ($1, $2, $3, 'Resend', $4, 'success', $5)`,
        [id, `${id}@example.test`, template, messageId, tracked ? { engagementTracking: 'resend-v1' } : {}],
      );
    service = new MailEngagementService({
      table: 'mail_history',
      query: async (sql, values) => (await client.query(sql, values)).rows,
      trackingConfigured: () => true,
    });
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });

  it('counts delivery, bounces and engagement once per message, overall and per template', async () => {
    const base = Date.now();
    const at = (offset: number) => new Date(base - offset).toISOString();
    const event = (type: string, emailId: string, offset = 0) =>
      service.record({ type, created_at: at(offset), data: { email_id: emailId } });
    await event('email.delivered', 'm1');
    await event('email.opened', 'm1', 2000);
    await event('email.opened', 'm1', 1000); // repeated open keeps the earliest first time
    await event('email.clicked', 'm1');
    await event('email.delivered', 'm2');
    await event('email.opened', 'm2');
    await event('email.bounced', 'm3');
    await event('email.delivered', 'm4');
    await event('email.opened', 'm4'); // untracked code mail stays out of the rate

    const [m1] = (await client.query(`SELECT metadata FROM mail_history WHERE id = '1'`)).rows;
    expect(m1.metadata.engagement).toMatchObject({ firstOpenedAt: at(2000), lastOpenedAt: at(1000) });

    const total = await service.stats();
    expect(total).toMatchObject({ accepted: 4, delivered: 3, bounced: 1, opened: 3, clicked: 1, trackedDelivered: 2, trackedOpened: 2 });
    expect(total.openRate).toBe(1);
    expect(total.bounceRate).toBe(0.25);

    const { templates } = await service.byTemplate();
    expect(templates.map((row) => [row.template, row.accepted, row.delivered, row.bounced, row.clickRate])).toEqual([
      ['welcome', 3, 2, 1, 0.5],
      ['code', 1, 1, 0, null],
    ]);
  });
});
