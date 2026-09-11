import type { DatabaseAdapter } from '@zucker-framework/core';

export interface LoginAuditData {
  userId: string;
  loginMethod: string;
  ip: string;
  userAgent?: string;
  success?: boolean;
  failReason?: string;
}
export interface LoginAuditOptions {
  historyModel: string;
  userModel: string;
  userAgentMaxLength?: number;
  onError?: (error: unknown) => void;
}

/** Best-effort login history; successful-login counters and history commit atomically. */
export class LoginAuditService {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly options: LoginAuditOptions,
  ) {}

  async record(input: LoginAuditData): Promise<void> {
    const { userId, loginMethod, ip, userAgent, success = true, failReason } = input;
    const data = {
      userId,
      loginMethod,
      ip,
      success,
      userAgent: userAgent?.slice(0, this.options.userAgentMaxLength ?? 500),
      ...(success ? {} : { failReason }),
    };
    try {
      if (success) {
        await this.db.$transaction(async (tx) => {
          await tx.model(this.options.historyModel).create({ data });
          await tx.model(this.options.userModel).update({
            where: { id: userId },
            data: { lastLoginAt: new Date(), lastLoginIp: ip, loginCount: { increment: 1 } },
          });
        });
      } else {
        await this.db.model(this.options.historyModel).create({ data });
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
