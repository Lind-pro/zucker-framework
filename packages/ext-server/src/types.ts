// vendored 边界：core 只依赖这些接口，由消费方装配层用 PrismaService / MailService 满足。
// Prisma delegate 的完整类型无法跨仓库携带，这里用松签名（消费方传真 Prisma，类型安全在消费方）。

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface StoreDelegate {
  findUnique(args: any): Promise<any>;
  findMany(args?: any): Promise<any[]>;
  create(args: any): Promise<any>;
  update(args: any): Promise<any>;
  upsert(args: any): Promise<any>;
  count(args?: any): Promise<number>;
}

export interface ExtStore {
  extensionLicense: StoreDelegate;
  extensionActivation: StoreDelegate;
  extensionOrder: StoreDelegate;
  extensionFreeUsage: StoreDelegate;
  extensionProduct: StoreDelegate;
}

export interface ExtMailer {
  sendMail(options: {
    to: string;
    from?: string;
    subject: string;
    html: string;
  }): Promise<boolean>;
}

export interface ProductInfo {
  displayName: string;
  senderBrand: string;
}

export interface ExtServerOptions {
  /** 激活码/token 哈希盐 */
  licenseSecret: string;
  /** Stripe webhook 签名密钥；未配则 webhook 返回 503 */
  stripeWebhookSecret?: string;
  /** 消费项目在邮件服务商验证过的发件域名 */
  mailDomain: string;
  /** webhook 无产品标识时的兜底产品 slug */
  defaultProduct: string;
  /** 消费项目提供的激活码前缀 */
  codePrefix: string;
  /** 授权默认附带的功能位 */
  proFeatures: string[];
  /** DB 无 ExtensionProduct 记录时的兜底（slug 子串匹配，保持历史行为） */
  fallbackProducts: Record<string, ProductInfo>;
  /** 以上都不匹配时的兜底品牌 */
  fallbackBrand: ProductInfo;
}

export interface ActivateInput {
  code: string;
  deviceId: string;
  deviceName?: string;
  email?: string;
}

export interface ConsumeFreeInput {
  deviceId: string;
  accountId: string;
  accountLabel?: string;
}

export interface CreateLicensesInput {
  count?: number;
  plan?: string;
  durationDays?: number;
  maxDevices?: number;
  features?: string[];
}
