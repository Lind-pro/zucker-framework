import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotifyAction } from './notify-action';
import type { NotifyActionConfig, NotifySender, NotifyEvent } from './notify-action';

describe('NotifyAction', () => {
  let action: NotifyAction;

  beforeEach(() => {
    action = new NotifyAction();
  });

  // ─── validate ───────────────────────────────────────────────────────────────

  describe('validate()', () => {
    it('notifyType이 없으면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ notifyType: '', recipients: ['u1'] }),
      ).toThrow('Notify type is required');
    });

    it('공백만 있는 notifyType이면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ notifyType: '   ', recipients: ['u1'] }),
      ).toThrow('Notify type is required');
    });

    it('수신자 목록이 비어 있으면 오류를 던져야 한다', () => {
      expect(() =>
        action.validate({ notifyType: 'email', recipients: [] }),
      ).toThrow('At least one recipient is required');
    });

    it('유효한 설정이면 오류를 던지지 않아야 한다', () => {
      expect(() =>
        action.validate({ notifyType: 'sms', recipients: ['user1'] }),
      ).not.toThrow();
    });
  });

  // ─── 기본 실행 ───────────────────────────────────────────────────────────────

  describe('execute() 기본 동작', () => {
    it('sender가 없어도 정상 완료되어야 한다 (로그만)', async () => {
      const config: NotifyActionConfig = {
        notifyType: 'email',
        recipients: ['alice@example.com'],
        message: 'Hello',
      };
      await expect(action.execute(config, {})).resolves.toBeUndefined();
    });

    it('sender가 등록되면 NotifyEvent를 전달해야 한다', async () => {
      const sender: NotifySender = vi.fn().mockResolvedValue(undefined);
      action.setSender(sender);

      const config: NotifyActionConfig = {
        notifyType: 'push',
        recipients: ['user1', 'user2'],
        title: '알림',
        message: '메시지 내용',
      };
      await action.execute(config, { key: 'val' });

      expect(sender).toHaveBeenCalledOnce();
      const event: NotifyEvent = (sender as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.type).toBe('push');
      expect(event.recipients).toEqual(['user1', 'user2']);
      expect(event.title).toBe('알림');
      expect(event.message).toBe('메시지 내용');
    });
  });

  // ─── 템플릿 변수 치환 ────────────────────────────────────────────────────────

  describe('템플릿 변수 치환', () => {
    it('title 및 message의 ${variable}을 data에서 치환해야 한다', async () => {
      const sender: NotifySender = vi.fn().mockResolvedValue(undefined);
      action.setSender(sender);

      const config: NotifyActionConfig = {
        notifyType: 'email',
        recipients: ['admin'],
        title: '기기 ${deviceId} 경보',
        message: '온도: ${temperature}°C',
      };
      await action.execute(config, { deviceId: 'D42', temperature: 85 });

      const event: NotifyEvent = (sender as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.title).toBe('기기 D42 경보');
      expect(event.message).toBe('온도: 85°C');
    });

    it('중첩 경로 ${a.b}를 title에서 치환해야 한다', async () => {
      const sender: NotifySender = vi.fn().mockResolvedValue(undefined);
      action.setSender(sender);

      const config: NotifyActionConfig = {
        notifyType: 'slack',
        recipients: ['ops-channel'],
        title: '센서 ${device.name} 이상',
      };
      await action.execute(config, { device: { name: 'Temp-Sensor-1' } });

      const event: NotifyEvent = (sender as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.title).toBe('센서 Temp-Sensor-1 이상');
    });

    it('존재하지 않는 변수는 빈 문자열로 치환해야 한다', async () => {
      const sender: NotifySender = vi.fn().mockResolvedValue(undefined);
      action.setSender(sender);

      const config: NotifyActionConfig = {
        notifyType: 'email',
        recipients: ['u1'],
        title: 'val=${missing}',
      };
      await action.execute(config, {});

      const event: NotifyEvent = (sender as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.title).toBe('val=');
    });
  });

  // ─── variables 매핑 해소 ────────────────────────────────────────────────────

  describe('variables 매핑 해소', () => {
    it('variables 맵을 data에서 해소하여 resolvedVariables에 담아야 한다', async () => {
      const sender: NotifySender = vi.fn().mockResolvedValue(undefined);
      action.setSender(sender);

      const config: NotifyActionConfig = {
        notifyType: 'email',
        recipients: ['u1'],
        variables: {
          deviceName: 'device.name',
          temp: 'payload.temperature',
        },
      };
      const data = {
        device: { name: 'Boiler-1' },
        payload: { temperature: 120 },
      };
      await action.execute(config, data);

      const event: NotifyEvent = (sender as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.resolvedVariables).toEqual({
        deviceName: 'Boiler-1',
        temp: 120,
      });
    });

    it('단순 키 변수도 해소해야 한다', async () => {
      const sender: NotifySender = vi.fn().mockResolvedValue(undefined);
      action.setSender(sender);

      const config: NotifyActionConfig = {
        notifyType: 'sms',
        recipients: ['u1'],
        variables: { userId: 'uid' },
      };
      await action.execute(config, { uid: 'user-007' });

      const event: NotifyEvent = (sender as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.resolvedVariables!.userId).toBe('user-007');
    });

    it('variables가 없으면 resolvedVariables는 빈 객체여야 한다', async () => {
      const sender: NotifySender = vi.fn().mockResolvedValue(undefined);
      action.setSender(sender);

      const config: NotifyActionConfig = {
        notifyType: 'email',
        recipients: ['u1'],
      };
      await action.execute(config, {});

      const event: NotifyEvent = (sender as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.resolvedVariables).toEqual({});
    });
  });

  // ─── templateId 라우팅 ──────────────────────────────────────────────────────

  describe('templateId 라우팅', () => {
    it('templateId를 이벤트에 포함해야 한다', async () => {
      const sender: NotifySender = vi.fn().mockResolvedValue(undefined);
      action.setSender(sender);

      const config: NotifyActionConfig = {
        notifyType: 'email',
        templateId: 'tmpl-alarm-001',
        recipients: ['ops@example.com'],
      };
      await action.execute(config, {});

      const event: NotifyEvent = (sender as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(event.templateId).toBe('tmpl-alarm-001');
    });
  });
});
