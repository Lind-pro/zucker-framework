import { OrderService } from './order.service';
import { PaymentService } from './payment.service';
import type { CreateOrderParams } from './order.service';

function createMockPaymentService() {
  return {
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
      paidAt: new Date('2025-01-01'),
    }),
    refund: vi.fn().mockResolvedValue({
      id: 'refund-1',
      paymentId: 'pay-1',
      amount: 1000,
      status: 'succeeded',
    }),
  } as unknown as PaymentService;
}

describe('OrderService', () => {
  let service: OrderService;
  let paymentService: ReturnType<typeof createMockPaymentService>;

  const defaultParams: CreateOrderParams = {
    orderId: 'order-1',
    providerId: 'stripe',
    payment: { amount: 1000, currency: 'CNY' },
  };

  beforeEach(() => {
    paymentService = createMockPaymentService();
    service = new OrderService(paymentService as unknown as PaymentService);
  });

  describe('createOrder', () => {
    it('should create order and initiate payment', async () => {
      const order = await service.createOrder(defaultParams);

      expect(order.id).toBe('order-1');
      expect(order.status).toBe('paying');
      expect(order.paymentIntentId).toBe('intent-1');
      expect(order.amount).toBe(1000);
      expect(order.currency).toBe('CNY');
      expect(paymentService.createPaymentIntent).toHaveBeenCalledWith('stripe', defaultParams.payment);
    });

    it('should throw when order already exists', async () => {
      await service.createOrder(defaultParams);
      await expect(service.createOrder(defaultParams)).rejects.toThrow('已存在');
    });

    it('should set status to failed when payment initiation fails', async () => {
      (paymentService.createPaymentIntent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('payment error'));
      await expect(service.createOrder(defaultParams)).rejects.toThrow('payment error');

      const order = service.getOrder('order-1');
      expect(order.status).toBe('failed');
    });
  });

  describe('getOrder', () => {
    it('should return order by id', async () => {
      await service.createOrder(defaultParams);
      const order = service.getOrder('order-1');
      expect(order.id).toBe('order-1');
    });

    it('should throw for non-existent order', () => {
      expect(() => service.getOrder('nope')).toThrow('不存在');
    });
  });

  describe('confirmOrder', () => {
    it('should confirm payment and update to paid', async () => {
      await service.createOrder(defaultParams);
      const result = await service.confirmOrder('order-1');

      expect(result.status).toBe('succeeded');
      const order = service.getOrder('order-1');
      expect(order.status).toBe('paid');
      expect(order.paymentId).toBe('pay-1');
    });

    it('should set status to failed when payment fails', async () => {
      (paymentService.confirmPayment as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'pay-1',
        status: 'failed',
        amount: 1000,
        currency: 'CNY',
      });
      await service.createOrder(defaultParams);
      await service.confirmOrder('order-1');

      const order = service.getOrder('order-1');
      expect(order.status).toBe('failed');
    });

    it('should throw when order is not in paying status', async () => {
      await service.createOrder(defaultParams);
      await service.confirmOrder('order-1'); // now 'paid'
      await expect(service.confirmOrder('order-1')).rejects.toThrow('无法确认支付');
    });
  });

  describe('refundOrder', () => {
    it('should refund a paid order', async () => {
      await service.createOrder(defaultParams);
      await service.confirmOrder('order-1');

      const result = await service.refundOrder('order-1', 500, 'not satisfied');
      expect(result.status).toBe('succeeded');

      const order = service.getOrder('order-1');
      expect(order.status).toBe('refunded');
      expect(paymentService.refund).toHaveBeenCalledWith('stripe', 'pay-1', 500, 'not satisfied');
    });

    it('should restore to paid when refund fails', async () => {
      (paymentService.refund as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'refund-1',
        paymentId: 'pay-1',
        amount: 1000,
        status: 'failed',
      });
      await service.createOrder(defaultParams);
      await service.confirmOrder('order-1');
      await service.refundOrder('order-1');

      const order = service.getOrder('order-1');
      expect(order.status).toBe('paid');
    });

    it('should throw when order is not paid', async () => {
      await service.createOrder(defaultParams);
      await expect(service.refundOrder('order-1')).rejects.toThrow('无法退款');
    });
  });

  describe('cancelOrder', () => {
    it('should cancel a created/paying/failed order', async () => {
      // paying state
      await service.createOrder(defaultParams);
      const cancelled = service.cancelOrder('order-1');
      expect(cancelled.status).toBe('cancelled');
    });

    it('should throw when cancelling a paid order', async () => {
      await service.createOrder(defaultParams);
      await service.confirmOrder('order-1');
      expect(() => service.cancelOrder('order-1')).toThrow('无法取消');
    });

    it('should allow cancelling a failed order', async () => {
      (paymentService.createPaymentIntent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
      try { await service.createOrder(defaultParams); } catch {}
      const cancelled = service.cancelOrder('order-1');
      expect(cancelled.status).toBe('cancelled');
    });
  });

  describe('listOrders', () => {
    it('should return all orders as copies', async () => {
      await service.createOrder(defaultParams);
      await service.createOrder({ ...defaultParams, orderId: 'order-2' });
      const list = service.listOrders();
      expect(list).toHaveLength(2);
    });
  });
});
