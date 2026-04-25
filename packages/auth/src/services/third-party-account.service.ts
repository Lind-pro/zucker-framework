import { Injectable, Logger } from '@nestjs/common';
import { type DatabaseAdapter, BusinessException, NotFoundException } from '@zucker/core';

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
interface ThirdPartyBindRecord {
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

@Injectable()
export class ThirdPartyAccountService {
  private readonly logger = new Logger(ThirdPartyAccountService.name);

  constructor(private readonly db: DatabaseAdapter) {}

  /** 绑定第三方账号到用户 */
  async bindAccount(
    userId: string,
    provider: string,
    profile: ThirdPartyProfile,
  ): Promise<void> {
    // 检查该第三方账号是否已被其他用户绑定
    const existing = await this.db.model('thirdPartyBinds').findUnique({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId: profile.providerAccountId,
        },
      },
    }) as ThirdPartyBindRecord | null;

    if (existing && existing.userId !== userId) {
      throw new BusinessException(
        `该 ${provider} 账号已被其他用户绑定`,
        'THIRD_PARTY_ALREADY_BOUND',
        400,
      );
    }

    if (existing && existing.userId === userId) {
      // 更新已有绑定
      await this.db.model('thirdPartyBinds').update({
        where: { id: existing.id },
        data: {
          email: profile.email,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
          accessToken: profile.accessToken,
          refreshToken: profile.refreshToken,
          expiresAt: profile.expiresAt,
          profileData: profile.profileData
            ? JSON.parse(JSON.stringify(profile.profileData))
            : undefined,
        },
      });
      return;
    }

    await this.db.model('thirdPartyBinds').create({
      data: {
        userId,
        provider,
        providerAccountId: profile.providerAccountId,
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        accessToken: profile.accessToken,
        refreshToken: profile.refreshToken,
        expiresAt: profile.expiresAt,
        profileData: profile.profileData
          ? JSON.parse(JSON.stringify(profile.profileData))
          : undefined,
      },
    });

    this.logger.log(
      `用户 ${userId} 绑定了 ${provider} 账号 ${profile.providerAccountId}`,
    );
  }

  /** 解绑第三方账号（禁止解绑最后一个登录方式） */
  async unbindAccount(userId: string, provider: string): Promise<void> {
    // 检查用户是否有密码（如果有密码，解绑第三方账号是安全的）
    const user = await this.db.model('users').findUnique({
      where: { id: userId },
      select: { password: true },
    }) as { password?: string } | null;

    // 检查用户绑定了多少个第三方账号
    const binds = await this.db.model('thirdPartyBinds').findMany({
      where: { userId },
    }) as ThirdPartyBindRecord[];

    const hasPassword = !!user?.password;
    const bindCount = binds.length;

    // 如果没有密码且只剩一个绑定，禁止解绑
    if (!hasPassword && bindCount <= 1) {
      throw new BusinessException(
        '无法解绑最后一个登录方式，请先设置密码或绑定其他第三方账号',
        'CANNOT_UNBIND_LAST_LOGIN',
        400,
      );
    }

    const bind = binds.find((b) => b.provider === provider);
    if (!bind) {
      throw new NotFoundException(`未找到 ${provider} 的绑定记录`);
    }

    await this.db.model('thirdPartyBinds').delete({
      where: { id: bind.id },
    });

    this.logger.log(`用户 ${userId} 解绑了 ${provider} 账号`);
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
    // 查找已有绑定
    const existing = await this.db.model('thirdPartyBinds').findUnique({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId: profile.providerAccountId,
        },
      },
    }) as ThirdPartyBindRecord | null;

    if (existing) {
      // 更新 token 等信息
      await this.db.model('thirdPartyBinds').update({
        where: { id: existing.id },
        data: {
          accessToken: profile.accessToken,
          refreshToken: profile.refreshToken,
          expiresAt: profile.expiresAt,
          profileData: profile.profileData
            ? JSON.parse(JSON.stringify(profile.profileData))
            : undefined,
        },
      });

      return { userId: existing.userId, isNew: false };
    }

    // 如果有 email，尝试通过 email 查找已有用户
    if (profile.email) {
      const userByEmail = await this.db.model('users').findUnique({
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
    const newUser = await this.db.model('users').create({
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
  ): Promise<
    Array<{ provider: string; displayName?: string; email?: string }>
  > {
    return this.db.model('thirdPartyBinds').findMany({
      where: { userId },
      select: {
        provider: true,
        displayName: true,
        email: true,
      },
    }) as Promise<Array<{ provider: string; displayName?: string; email?: string }>>;
  }
}
