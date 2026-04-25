import { describe, it, expect } from 'vitest';
import { createTransport, Transports } from './transport';

describe('createTransport', () => {
  it('should create a Transport with protocol and schema', () => {
    const t = createTransport('TCP', 'mqtt');
    expect(t.protocol).toBe('TCP');
    expect(t.schema).toBe('mqtt');
  });

  it('should create UDP transport', () => {
    const t = createTransport('UDP', 'custom');
    expect(t.protocol).toBe('UDP');
    expect(t.schema).toBe('custom');
  });
});

describe('Transports', () => {
  it('should define TCP constant', () => {
    expect(Transports.TCP.protocol).toBe('TCP');
    expect(Transports.TCP.schema).toBe('tcp');
  });

  it('should define UDP constant', () => {
    expect(Transports.UDP.protocol).toBe('UDP');
    expect(Transports.UDP.schema).toBe('udp');
  });

  it('should define HTTP/HTTPS as TCP-based', () => {
    expect(Transports.HTTP.protocol).toBe('TCP');
    expect(Transports.HTTP.schema).toBe('http');
    expect(Transports.HTTPS.protocol).toBe('TCP');
    expect(Transports.HTTPS.schema).toBe('https');
  });

  it('should define MQTT/MQTTS as TCP-based', () => {
    expect(Transports.MQTT.protocol).toBe('TCP');
    expect(Transports.MQTT.schema).toBe('mqtt');
    expect(Transports.MQTTS.protocol).toBe('TCP');
    expect(Transports.MQTTS.schema).toBe('mqtts');
  });

  it('should define WS/WSS as TCP-based', () => {
    expect(Transports.WS.protocol).toBe('TCP');
    expect(Transports.WS.schema).toBe('ws');
    expect(Transports.WSS.protocol).toBe('TCP');
    expect(Transports.WSS.schema).toBe('wss');
  });
});
