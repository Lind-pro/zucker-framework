export function notificationRecipientCount(
  recipient: string | string[],
): number {
  return Array.isArray(recipient) ? recipient.length : 1;
}

export function notificationDeliveryLog(
  channel: string,
  provider: string,
  recipient: string | string[],
): string {
  return `Notification sent: channel=${channel}, provider=${provider}, recipients=${notificationRecipientCount(recipient)}`;
}

export function notificationFailureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(code)) {
      return code;
    }
  }
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : 'NOTIFICATION_FAILED';
}
