import { describe, expect, it, vi } from 'vitest';
import {
  NotifierEventDispatcher,
  NotifierEventTopics,
  type NotificationEventBus,
} from './notifier-event-dispatcher';
import {
  NotifyChannel,
  type Notifier,
  type NotifyResult,
} from './notifier.interface';

function notifier(send: Notifier['send']): Notifier {
  return {
    notifierId: 'notifier-1',
    channel: NotifyChannel.EMAIL,
    provider: 'resend',
    send,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('NotifierEventDispatcher', () => {
  it('emits delivery metadata without recipient or message content', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const result: NotifyResult = {
      success: true,
      channel: NotifyChannel.EMAIL,
      to: 'recipient@example.com',
      timestamp: new Date(),
    };
    const dispatcher = new NotifierEventDispatcher(
      notifier(vi.fn().mockResolvedValue(result)),
      { publish } satisfies NotificationEventBus,
    );

    await dispatcher.send({
      channel: NotifyChannel.EMAIL,
      to: ['recipient@example.com', 'second@example.com'],
      subject: 'private subject',
      variables: { patentText: 'private patent text' },
    });

    expect(publish).toHaveBeenCalledWith(
      NotifierEventTopics.success('notifier-1'),
      expect.objectContaining({
        success: true,
        recipientCount: 2,
        provider: 'resend',
      }),
    );
    const serialized = JSON.stringify(publish.mock.calls[0]);
    expect(serialized).not.toContain('recipient@example.com');
    expect(serialized).not.toContain('private patent text');
    expect(serialized).not.toContain('private subject');
  });

  it('emits a low-cardinality failure code without the raw error', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new NotifierEventDispatcher(
      notifier(
        vi.fn().mockRejectedValue(
          new Error('recipient@example.com rejected private content'),
        ),
      ),
      { publish } satisfies NotificationEventBus,
    );

    await expect(
      dispatcher.send({
        channel: NotifyChannel.EMAIL,
        to: 'recipient@example.com',
        variables: {},
      }),
    ).rejects.toThrow('rejected private content');

    expect(publish).toHaveBeenCalledWith(
      NotifierEventTopics.error('notifier-1'),
      expect.objectContaining({
        success: false,
        errorType: 'Error',
        errorCode: 'Error',
        recipientCount: 1,
      }),
    );
    expect(JSON.stringify(publish.mock.calls[0])).not.toContain(
      'recipient@example.com',
    );
  });
});
