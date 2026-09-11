import { UAParser } from 'ua-parser-js';

export interface UserAgentDetails {
  browserName: string | null;
  browserVersion: string | null;
  osName: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  deviceVendor: string | null;
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'bot';
}

/** Browser-safe UA mechanics. Labels, version display and fallbacks belong to the UI. */
export function inspectUserAgent(ua: string | null | undefined): UserAgentDetails {
  if (!ua)
    return {
      browserName: null,
      browserVersion: null,
      osName: null,
      osVersion: null,
      deviceModel: null,
      deviceVendor: null,
      deviceType: 'desktop',
    };
  const parser = new UAParser(ua);
  const browser = parser.getBrowser();
  const os = parser.getOS();
  const device = parser.getDevice();
  return {
    browserName: browser.name || null,
    browserVersion: browser.version || null,
    osName: os.name || null,
    osVersion: os.version || null,
    deviceModel: device.model || null,
    deviceVendor: device.vendor || null,
    deviceType:
      device.type === 'mobile'
        ? 'mobile'
        : device.type === 'tablet'
          ? 'tablet'
          : /bot|spider|crawler/i.test(ua)
            ? 'bot'
            : 'desktop',
  };
}
