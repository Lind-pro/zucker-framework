import { describe, expect, it } from 'vitest';
import { NotifyHistoryService, type NotifyChannel, type TemplateService } from '@zucker-framework/notification';
import { NotificationController } from './notification.controller';

describe('NotificationController.queryHistory', () => {
  it('pages beyond the first 100 records and reports the full total', () => {
    const history = new NotifyHistoryService();
    for (let i = 0; i < 150; i += 1) {
      history.record(
        { channel: 'EMAIL' as NotifyChannel, to: `u${i}@example.test`, variables: {} },
        { success: true, channel: 'EMAIL' as NotifyChannel, to: `u${i}@example.test`, timestamp: new Date(1_000 + i) },
      );
    }
    const controller = new NotificationController({} as TemplateService, history);

    const page = controller.queryHistory({ pageIndex: 14, pageSize: 10 });

    expect(page.total).toBe(150);
    expect(page.data).toHaveLength(10);
    expect(page.data[9].to).toBe('u0@example.test');
  });
});
