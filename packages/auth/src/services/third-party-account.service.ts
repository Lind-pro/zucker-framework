import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { type DatabaseAdapter, BusinessException, NotFoundException } from '@zucker-framework/core';

export interface ThirdPartyProfile {
  providerAccountId: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  profileData?: Record<string, unknown>;
}

/** Internal record shape for third_party_binds table */
export interface ThirdPartyBindRecord {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  profileData?: Record<string, unknown>;
}

export interface ThirdPartyBindingRequest {
  user: { id: string; [claim: string]: unknown };
  headers?: { cookie?: string; authorization?: string; [header: string]: string | string[] | undefined };
}
export interface ThirdPartyBindingProofInput {
  userId: string;
  provider: string;
  proof: string;
  /** Current authenticated request for resolving its session/browser binding. */
  request: ThirdPartyBindingRequest;
}

export interface ThirdPartyAccountOptions {
  /** Consume a server-issued proof bound to this authenticated user/session/browser/provider. */
  resolveBindingProof?: (input: ThirdPartyBindingProofInput) => Promise<ThirdPartyProfile>;
  bindingsModel?: string;
  usersModel?: string;
  /** Reject a second account of the same provider, including the same account. */
  rejectDuplicateProvider?: boolean;
  /** Must serialize all bind/unbind operations for this user and bind the supplied database to that transaction. */
  withUserLock?: <T>(userId: string, work: (db: DatabaseAdapter) => Promise<T>) => Promise<T>;
}

@Injectable()
export class ThirdPartyAccountService {
  private readonly logger = new Logger(ThirdPartyAccountService.name);

  constructor(private readonly db: DatabaseAdapter, private readonly options: ThirdPartyAccountOptions = {}) {}

  private get bindingsModel() { return this.options.bindingsModel ?? 'thirdPartyBinds'; }
  private get usersModel() { return this.options.usersModel ?? 'users'; }
  private runLocked<T>(userId: string, work: (db: DatabaseAdapter) => Promise<T>): Promise<T> {
    return this.options.withUserLock ? this.options.withUserLock(userId, work) : this.db.$transaction(work);
  }
  private profileData(profile: ThirdPartyProfile) {
    return {
      email: profile.email, displayName: profile.displayName, avatarUrl: profile.avatarUrl,
      accessToken: profile.accessToken, refreshToken: profile.refreshToken, expiresAt: profile.expiresAt,
      profileData: profile.profileData ? JSON.parse(JSON.stringify(profile.profileData)) : undefined,
    };
  }

  findAccount(provider: string, providerAccountId: string): Promise<ThirdPartyBindRecord | null> {
    return this.db.model(this.bindingsModel).findUnique({ where: {
      provider_providerAccountId: { provider, providerAccountId },
    } }) as Promise<ThirdPartyBindRecord | null>;
  }

  async refreshAccount(id: string, profile: ThirdPartyProfile): Promise<void> {
    await this.db.model(this.bindingsModel).update({ where: { id }, data: this.profileData(profile) });
  }

  /** HTTP boundary: an unconfigured resolver and browser-supplied profiles never establish ownership. */
  async bindAccountWithProof(userId: string, provider: string, proof: unknown, request: ThirdPartyBindingRequest): Promise<void> {
    if (!this.options.resolveBindingProof || typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof) ||
      typeof provider !== 'string' || !provider || provider.length > 100 || !userId || request?.user?.id !== userId) {
      throw new UnauthorizedException('A verified account binding proof is required');
    }
    const profile = await this.options.resolveBindingProof({ userId, provider, proof, request });
    if (!profile || typeof profile.providerAccountId !== 'string' || !profile.providerAccountId) {
      throw new UnauthorizedException('Invalid account binding proof');
    }
    // The resolver's claim and this write are not automatically one transaction. Custom consumers
    // requiring atomicity must compose proof consumption and bindAccount in their own transaction.
    await this.bindAccount(userId, provider, profile);
  }

  /** Trusted server primitive; callers must already have verified the provider identity. */
  async bindAccount(
    userId: string,
    provider: string,
    profile: ThirdPartyProfile,
  ): Promise<void> {
    await this.runLocked(userId, async (db) => {
      const model = db.model(this.bindingsModel);
      const existing = await model.findUnique({ where: {
        provider_providerAccountId: { provider, providerAccountId: profile.providerAccountId },
      } }) as ThirdPartyBindRecord | null;
      if (existing && existing.userId !== userId) {
        throw new BusinessException(`该 ${provider} 账号已被其他用户绑定`, 'THIRD_PARTY_ALREADY_BOUND', 400);
      }
      if (this.options.rejectDuplicateProvider) {
        const binds = await model.findMany({ where: { userId, provider }, take: 1 });
        if (binds.length) throw new BusinessException('A provider account is already bound', 'THIRD_PARTY_PROVIDER_BOUND', 400);
      }
      if (existing) {
        await model.update({ where: { id: existing.id }, data: this.profileData(profile) });
      } else {
        await model.create({ data: { userId, provider,
          providerAccountId: profile.providerAccountId, ...this.profileData(profile) } });
      }
    });
  }

  /** With a configured user lock, two concurrent unbinds cannot remove the final login method. */
  async unbindAccount(userId: string, provider: string): Promise<void> {
    await this.runLocked(userId, async (db) => {
      const user = await db.model(this.usersModel).findUnique({
        where: { id: userId }, select: { password: true },
      }) as { password?: string | null } | null;
      const model = db.model(this.bindingsModel);
      const binds = await model.findMany({ where: { userId } }) as ThirdPartyBindRecord[];
      if (!user?.password && binds.length <= 1) {
        throw new BusinessException('无法解绑最后一个登录方式，请先设置密码或绑定其他第三方账号', 'CANNOT_UNBIND_LAST_LOGIN', 400);
      }
      const bind = binds.find((item) => item.provider === provider);
      if (!bind) throw new NotFoundException(`未找到 ${provider} 的绑定记录`);
      await model.delete({ where: { id: bind.id } });
    });
  }

  /**
   * OAuth 登录时查找或创建用户
   * 如果第三方账号已绑定，返回绑定的用户
   * 如果未绑定，创建新用户并绑定
   */
  async findOrCreateUser(
    provider: string,
    profile: ThirdPartyProfile,
  ): Promise<{ userId: string; isNew: boolean }> {
    const existing = await this.findAccount(provider, profile.providerAccountId);

    if (existing) {
      await this.refreshAccount(existing.id, profile);

      return { userId: existing.userId, isNew: false };
    }

    // 如果有 email，尝试通过 email 查找已有用户
    if (profile.email) {
      const userByEmail = await this.db.model(this.usersModel).findUnique({
        where: { email: profile.email },
      }) as { id: string } | null;

      if (userByEmail) {
        await this.bindAccount(userByEmail.id, provider, profile);
        return { userId: userByEmail.id, isNew: false };
      }
    }

    // 创建新用户
    const username =
      profile.displayName ||
      `${provider}_${profile.providerAccountId}`;
    const newUser = await this.db.model(this.usersModel).create({
      data: {
        username,
        name: profile.displayName || username,
        typeId: 'oauth',
        email: profile.email,
        emailVerified: !!profile.email,
        status: true,
      },
    }) as { id: string };

    // 绑定第三方账号
    await this.bindAccount(newUser.id, provider, profile);

    this.logger.log(
      `通过 ${provider} OAuth 创建新用户 ${newUser.id}`,
    );

    return { userId: newUser.id, isNew: true };
  }

  /** 获取用户的所有第三方绑定 */
  async getUserBinds(
    userId: string,
    select: Record<string, boolean> = { provider: true, displayName: true, email: true },
  ): Promise<Array<{ provider: string; displayName?: string; email?: string }>> {
    return this.db.model(this.bindingsModel).findMany({
      where: { userId },
      select,
    }) as Promise<Array<{ provider: string; displayName?: string; email?: string }>>;
  }
}
