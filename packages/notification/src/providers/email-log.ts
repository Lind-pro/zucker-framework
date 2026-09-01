export function emailRecipientCount(recipient: string | string[]): number {
  return Array.isArray(recipient) ? recipient.length : 1;
}

export function emailDeliveryLog(provider: string, recipient: string | string[]): string {
  return `Email sent via ${provider}: recipients=${emailRecipientCount(recipient)}`;
}
