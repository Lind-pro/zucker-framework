import { afterEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZuckerRateLimiterModule } from '@zucker-framework/rate-limiter';
import { HttpExceptionFilter } from '@zucker-framework/common';
import request from 'supertest';
import { BILLING_OPTIONS, BillingService, type BillingOptions } from '../src/billing/billing.service';
import {
  billingTestFakeControllers, billingTestFakesEnabled, createBillingTestFakes, FakeCheckoutController,
} from '../src/billing/test-fakes';

/**
 * The fake provider's off switch and its production refusal in all three independent places (switch, adapter factory,
 * controller constructor), checked against a real Nest HTTP app without a database.
 */
const base = { WEB_URL: 'http://localhost:4202' };
const apps: INestApplication[] = [];

async function appFor(env: Record<string, string | undefined>) {
  const fakes = createBillingTestFakes({ ...base, NODE_ENV: 'test' });
  const options = { providers: [fakes.checkout], webUrl: base.WEB_URL, catalogJson: '[]' } as unknown as BillingOptions;
  const module = await Test.createTestingModule({
    imports: [ZuckerRateLimiterModule.forRoot({ globalGuard: false, limiters: { 'billing-webhook': { points: 1000, duration: 60 } } })],
    controllers: billingTestFakeControllers(env),
    providers: [{ provide: BILLING_OPTIONS, useValue: options }, { provide: BillingService, useValue: { webhook: async () => undefined } }],
  }).compile();
  const app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
  await app.init(); apps.push(app);
  return app;
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('billing test fakes: switch over HTTP', () => {
  it('mounts no route at all when the switch is off or false', async () => {
    for (const env of [{}, { BILLING_TEST_FAKE_PROVIDER: 'false' }, { BILLING_TEST_FAKE_PROVIDER: '' }]) {
      const app = await appFor(env);
      for (const [method, path] of [['get', '/api/billing/test-checkout/fakecs_00000000000000000000000000000000'],
        ['post', '/api/billing/test-checkout/refunds/mode'], ['post', '/api/billing/test-checkout/promotions'],
        ['post', '/api/billing/test-checkout/renew/fakesub_00000000000000000000000000000000'],
        ['post', '/api/billing/test-checkout/fakecs_00000000000000000000000000000000/pay']] as const) {
        const response = await request(app.getHttpServer())[method](path).send({ state: 'succeeded' });
        expect(response.status, `${method} ${path}`).toBe(404);
        // Express' own "Cannot GET" (no route), not the controller's NotFoundException.
        expect(JSON.stringify(response.body) + response.text, `${method} ${path}`).toMatch(/Cannot (GET|POST)/);
      }
    }
  });

  it('mounts the routes only for exactly true (the controller answers its own validation)', async () => {
    const app = await appFor({ BILLING_TEST_FAKE_PROVIDER: 'true' });
    const response = await request(app.getHttpServer()).post('/api/billing/test-checkout/refunds/mode').send({ state: 'exploded' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body) + response.text).not.toMatch(/Cannot POST/);
  });

  it('refuses a misspelled switch value instead of silently enabling or disabling the fake', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', 'enabled'])
      expect(() => billingTestFakeControllers({ BILLING_TEST_FAKE_PROVIDER: value })).toThrow(/true or false/);
  });

  it('refuses production in all three places, independently', async () => {
    const production = { NODE_ENV: 'production', BILLING_TEST_FAKE_PROVIDER: 'true' };
    // 1. the switch (and the controller list that depends on it)
    expect(() => billingTestFakesEnabled(production)).toThrow(/production/);
    expect(() => billingTestFakeControllers(production)).toThrow(/production/);
    // 2. the adapter factory, with or without the switch
    expect(() => createBillingTestFakes({ NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => createBillingTestFakes(production)).toThrow(/production/);
    // 3. the controller, even if something mounts it directly
    const fakes = createBillingTestFakes({ ...base, NODE_ENV: 'test' });
    const options = { providers: [fakes.checkout] } as unknown as BillingOptions;
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new FakeCheckoutController({} as BillingService, options)).toThrow(/production/);
      await expect(Test.createTestingModule({
        imports: [ZuckerRateLimiterModule.forRoot({ globalGuard: false, limiters: { 'billing-webhook': { points: 10, duration: 60 } } })],
        controllers: [FakeCheckoutController],
        providers: [{ provide: BILLING_OPTIONS, useValue: options }, { provide: BillingService, useValue: {} }],
      }).compile().then(module => module.createNestApplication().init())).rejects.toThrow(/production/);
    } finally { process.env.NODE_ENV = previous; }
    // Staging-like names are not production: the guard is exact, and the switch stays opt-in.
    expect(billingTestFakesEnabled({ BILLING_TEST_FAKE_PROVIDER: 'true', NODE_ENV: 'staging' })).toBe(true);
    expect(billingTestFakesEnabled({ NODE_ENV: 'production' })).toBe(false);
  });
});
