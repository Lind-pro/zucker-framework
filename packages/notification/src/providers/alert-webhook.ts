import { WebhookProvider, type WebhookProviderOptions } from './webhook';
import type { AlertChannel, FormattedAlert } from '../alert-notification.service';

export type AlertWebhookFormat = 'dingtalk' | 'wecom' | 'slack' | 'json';
export interface AlertWebhookOptions extends Omit<WebhookProviderOptions, 'defaultUrl'> {
  url: string;
  format: AlertWebhookFormat;
}
function formatAlert(alert: FormattedAlert, format: AlertWebhookFormat): unknown {
  const emoji =
    ({ CRITICAL: '🚨', WARNING: '⚠️', INFO: 'ℹ️' } as Record<string, string>)[alert.level] ?? '📢';
  if (format === 'dingtalk')
    return {
      msgtype: 'markdown',
      markdown: {
        title: alert.title,
        text: `### ${emoji} ${alert.title}\n\n**级别**: ${alert.level}\n\n**消息**: ${alert.message}\n\n**时间**: ${alert.timestamp}\n\n${alert.context ? `**上下文**:\n\`\`\`json\n${JSON.stringify(alert.context, null, 2)}\n\`\`\`` : ''}`.trim(),
      },
    };
  if (format === 'wecom')
    return {
      msgtype: 'markdown',
      markdown: {
        content: `## ${emoji} ${alert.title}\n\n> 级别: <font color="warning">${alert.level}</font>\n\n消息: ${alert.message}\n\n时间: ${alert.timestamp}`,
      },
    };
  if (format === 'slack')
    return {
      attachments: [
        {
          color:
            (
              { CRITICAL: '#FF0000', WARNING: '#FFA500', INFO: '#0000FF' } as Record<string, string>
            )[alert.level] ?? '#808080',
          title: alert.title,
          text: alert.message,
          fields: [
            { title: 'Level', value: alert.level, short: true },
            { title: 'Timestamp', value: alert.timestamp, short: true },
          ],
        },
      ],
    };
  return alert;
}
/** Provider wire formats reuse the common Webhook transport; no host URLs or severity policy are embedded. */
export function createWebhookAlertChannel(options: AlertWebhookOptions): AlertChannel {
  const provider = new WebhookProvider({
    ...options,
    defaultUrl: options.url,
    validateResponse:
      options.validateResponse ??
      (options.format === 'dingtalk' || options.format === 'wecom'
        ? async (response) => {
            const body: unknown = await response.json();
            if (!body || typeof body !== 'object' || !('errcode' in body) || body.errcode !== 0)
              throw new Error('Chat webhook rejected the notification');
          }
        : undefined),
  });
  return { send: (alert) => provider.sendPayload(formatAlert(alert, options.format)) };
}
