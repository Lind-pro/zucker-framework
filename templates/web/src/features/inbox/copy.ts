/**
 * Notification text by `type` (the server stores no text). Keep the keys in sync with
 * `templates/server/src/inbox/inbox-types.ts` `INBOX_TYPES`; an unknown type falls back to a
 * generic line. Params are numbers and short enumerations only. No React imports (node-testable).
 */
type Locale = 'en' | 'zh';
type Params = Record<string, unknown>;
interface Line { title: string; body: string }
type Describe = (params: Params, number: (value: number) => string) => Line;

const credits = (params: Params) => (typeof params.credits === 'number' && Number.isFinite(params.credits) ? params.credits : 0);
const kindLabel = (locale: Locale, kind: unknown) => {
  const labels = { en: { image: 'image', video: 'video', audio: 'audio' }, zh: { image: '图片', video: '视频', audio: '音频' } }[locale];
  return typeof kind === 'string' && kind in labels ? labels[kind as keyof typeof labels] : locale === 'zh' ? '生成' : 'generation';
};

const en = {
  title: 'Notifications',
  description: 'Payments, refunds, finished AI tasks and replies to your feedback.',
  bell: (unread: number) => (unread ? `Notifications, ${unread} unread` : 'Notifications'),
  all: 'All', unread: 'Unread', markAllRead: 'Mark all as read', markRead: 'Mark as read', archive: 'Archive', open: 'View',
  empty: 'No notifications yet.', emptyUnread: 'You are all caught up.', loading: 'Loading…',
  loadFailed: 'Notifications could not be loaded.', retry: 'Retry', actionFailed: 'That did not work. Try again.',
  previous: 'Previous', next: 'Next', page: (page: number, pages: number) => `Page ${page} of ${pages}`, unreadBadge: 'New',
  types: {
    'order.paid': (params, number) => ({ title: 'Payment received', body: credits(params) ? `${number(credits(params))} credits were added to your account.` : 'Your order is complete.' }),
    'subscription.renewed': (params, number) => ({ title: 'Subscription renewed', body: credits(params) ? `${number(credits(params))} credits for the new period were added.` : 'Your subscription was renewed.' }),
    'refund.settled': () => ({ title: 'Refund completed', body: 'Your refund was processed. It can take a few days to reach your account.' }),
    'ai.task.completed': (params) => ({ title: 'Generation finished', body: `Your ${kindLabel('en', params.kind)} is ready.` }),
    'ai.task.failed': (params) => ({ title: 'Generation failed', body: `Your ${kindLabel('en', params.kind)} task failed. Held credits were released.` }),
    'feedback.replied': () => ({ title: 'New reply to your feedback', body: 'Our team replied to your feedback.' }),
    'referral.rewarded': (params, number) => ({ title: 'Referral reward', body: `${number(credits(params))} referral credits were added to your account.` }),
  } as Record<string, Describe>,
  generic: { title: 'Notification', body: 'You have a new update.' },
};

const zh: typeof en = {
  title: '通知',
  description: '付款、退款、AI 任务完成和反馈回复。',
  bell: (unread) => (unread ? `通知，${unread} 条未读` : '通知'),
  all: '全部', unread: '未读', markAllRead: '全部标为已读', markRead: '标为已读', archive: '归档', open: '查看',
  empty: '还没有通知。', emptyUnread: '没有未读通知。', loading: '加载中…',
  loadFailed: '无法加载通知。', retry: '重试', actionFailed: '操作失败，请重试。',
  previous: '上一页', next: '下一页', page: (page, pages) => `第 ${page} / ${pages} 页`, unreadBadge: '新',
  types: {
    'order.paid': (params, number) => ({ title: '付款成功', body: credits(params) ? `已向你的账户添加 ${number(credits(params))} 积分。` : '你的订单已完成。' }),
    'subscription.renewed': (params, number) => ({ title: '订阅已续费', body: credits(params) ? `新周期的 ${number(credits(params))} 积分已到账。` : '你的订阅已续费。' }),
    'refund.settled': () => ({ title: '退款已完成', body: '退款已处理，到账可能需要几天。' }),
    'ai.task.completed': (params) => ({ title: '生成完成', body: `你的${kindLabel('zh', params.kind)}已生成。` }),
    'ai.task.failed': (params) => ({ title: '生成失败', body: `你的${kindLabel('zh', params.kind)}任务失败，冻结的积分已退回。` }),
    'feedback.replied': () => ({ title: '反馈有新回复', body: '我们的团队回复了你的反馈。' }),
    'referral.rewarded': (params, number) => ({ title: '邀请奖励', body: `${number(credits(params))} 邀请奖励积分已到账。` }),
  },
  generic: { title: '通知', body: '你有一条新动态。' },
};

export function inboxCopy(locale: string) {
  return locale === 'zh' ? zh : en;
}

/** Plain-text title and body for one notification; never renders HTML. */
export function describeNotification(locale: string, type: string, params: unknown): Line {
  const text = inboxCopy(locale);
  const safe = params && typeof params === 'object' && !Array.isArray(params) ? (params as Params) : {};
  const format = new Intl.NumberFormat(locale === 'zh' ? 'zh' : 'en');
  const describe = Object.hasOwn(text.types, type) ? text.types[type] : undefined;
  return describe ? describe(safe, (value) => format.format(value)) : text.generic;
}
