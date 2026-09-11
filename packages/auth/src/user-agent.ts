import { inspectUserAgent } from '@zucker-framework/core/user-agent';

export interface ParsedUserAgent {
  deviceLabel: string;
  deviceType: string;
  browserName: string | null;
  osName: string | null;
}
export interface UserAgentLabels {
  unknownDevice?: string;
  unknownBrowser?: string;
  format?: (browser: string, os: string) => string;
}

export function parseUserAgent(
  ua: string | undefined,
  labels: UserAgentLabels = {},
): ParsedUserAgent {
  if (!ua)
    return {
      deviceLabel: labels.unknownDevice ?? 'Unknown device',
      deviceType: 'desktop',
      browserName: null,
      osName: null,
    };
  const { browserName, osName, deviceType } = inspectUserAgent(ua);
  const browser = browserName ?? labels.unknownBrowser ?? 'Unknown browser';
  return {
    deviceType,
    browserName,
    osName,
    deviceLabel: osName ? (labels.format?.(browser, osName) ?? `${browser} on ${osName}`) : browser,
  };
}
