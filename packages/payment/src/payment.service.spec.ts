import { PaymentService } from './payment.service';
import type { PaymentProvider, CreatePaymentParams } from './payment.interface';

function createMockProvider(id = 'test-pay', name = 'Test Pay'): PaymentProvider {
  return {
    id,
    name,
    createPaymentIntent: vi.fn().mockResolvedValue({
      id: 'intent-1',
      status: 'pending',
      amount: 1000,
      currency: 'CNY',
    }),
    confirmPayment: vi.fn().mockResolvedValue({
      id: 'pay-1',
      status: 'succeeded',
      amount: 1000,
      currency: 'CNY',
      paidAt: new Date(),
    }),
    refund: vi.fn().mockResolvedValue({
      id: 'refund-1',
      paymentId: 'pay-1',
      amount: 1000,
      status: 'succeeded',
    }),
    getPaymentStatus: vi.fn().mockResolvedValue('succeeded'),
    handleWebhook: vi.fn().mockResolvedValue({ type: 'payment.completed', data: {} }),
  };
}

describe('PaymentService', () => {
  let service: PaymentService;
  let provider: PaymentProvider;

  beforeEach(() => {
    service = new PaymentService();
    provider = createMockProvider();
  });

  describe('register / unregister / listProviders', () => {
    it('should register a provider', () => {
      service.register(provider);
      expect(service.listProviders()).toHaveLength(1);
      expect(service.getProvider('test-pay')).toBe(provider);
    });

    it('should overwrite an existing provider with same id', () => {
      const provider2 = createMockProvider('test-pay', 'Test Pay v2');
      service.register(provider);
      service.register(provider2);
      expect(service.listProviders()).toHaveLength(1);
      expect(service.getProvider('test-pay').name).toBe('Test Pay v2');
    });

    it('should unregister a provider', () => {
      service.register(provider);
      expect(service.unregister('test-pay')).toBe(true);
      expect(service.listProviders()).toHaveLength(0);
    });

    it('should return false when unregistering non-existent provider', () => {
      expect(service.unregister('nope')).toBe(false);
    });
  });

  describe('getProvider', () => {
    it('should throw when provider not found', () => {
      expect(() => service.getProvider('missing')).toThrow('未注册');
    });
  });

  describe('createPaymentIntent', () => {
    it('should delegate to provider', async () => {
      service.register(provider);
      const params: CreatePaymentParams = { amount: 1000, currency: 'CNY', description: 'test' };
      const intent = await service.createPaymentIntent('test-pay', params);

      expect(provider.createPaymentIntent).toHaveBeenCalledWith(params);
      expect(intent.id).toBe('intent-1');
    });

    it('should throw for unregistered provider', async () => {
      await expect(
        service.createPaymentIntent('nope', { amount: 100, currency: 'USD' }),
      ).rejects.toThrow('未注册');
    });
  });

  describe('confirmPayment', () => {
    it('should delegate to provider', async () => {
      service.register(provider);
      const result = await service.confirmPayment('test-pay', 'intent-1');
      expect(provider.confirmPayment).toHaveBeenCalledWith('intent-1');
      expect(result.status).toBe('succeeded');
    });
  });

  describe('refund', () => {
    it('should delegate to provider with full params', async () => {
      service.register(provider);
      const result = await service.refund('test-pay', 'pay-1', 500, 'customer request');
      expect(provider.refund).toHaveBeenCalledWith('pay-1', 500, 'customer request');
      expect(result.status).toBe('succeeded');
    });

    it('should delegate to provider without optional params', async () => {
      service.register(provider);
      await service.refund('test-pay', 'pay-1');
      expect(provider.refund).toHaveBeenCalledWith('pay-1', undefined, undefined);
    });
  });

  describe('getPaymentStatus', () => {
    it('should return status from provider', async () => {
      service.register(provider);
      const status = await service.getPaymentStatus('test-pay', 'intent-1');
      expect(status).toBe('succeeded');
    });
  });

  describe('handleWebhook', () => {
    it('should delegate to provider', async () => {
      service.register(provider);
      const event = await service.handleWebhook('test-pay', { type: 'charge' }, 'sig-123');
      expect(provider.handleWebhook).toHaveBeenCalledWith({ type: 'charge' }, 'sig-123');
      expect(event.type).toBe('payment.completed');
    });
  });
});
