const en = {
  title: 'Invite friends',
  description: 'Share your link. When a friend you invite makes their first purchase, you both receive credits.',
  loading: 'Loading your invitation…', failed: 'Your invitation could not be loaded. Try again.', retry: 'Retry',
  disabled: 'The referral programme is not available right now.',
  codeInactive: 'Your invitation code has been deactivated. Contact support if you think this is a mistake.',
  link: 'Your invitation link', code: 'Code', copy: 'Copy link', copied: 'Copied', copyFailed: 'Copy failed, select the link instead.',
  noLink: 'Share your code: friends can enter the site with ?ref= followed by your code.',
  invited: 'Friends invited', rewarded: 'Rewards received', earned: 'Credits earned',
  rules: 'Credits are granted a few days after your friend\'s first purchase, as long as it is not refunded. Only new accounts can use an invitation.',
  recent: 'Recent invitations', none: 'No one has used your invitation yet.', joined: 'Joined',
  statusNames: { pending: 'Waiting for first purchase', granted: 'Rewarded', skipped: 'Not eligible' },
};
const zh: typeof en = {
  title: '邀请好友',
  description: '分享你的邀请链接。受邀好友完成首次购买后，你们双方都会获得积分奖励。',
  loading: '正在加载邀请信息…', failed: '邀请信息加载失败，请重试。', retry: '重试',
  disabled: '邀请计划当前未开放。',
  codeInactive: '你的邀请码已被停用。如有疑问请联系客服。',
  link: '你的邀请链接', code: '邀请码', copy: '复制链接', copied: '已复制', copyFailed: '复制失败，请手动选中链接。',
  noLink: '分享你的邀请码：好友访问网站时在地址后加上 ?ref= 和你的邀请码。',
  invited: '已邀请好友', rewarded: '已获奖励', earned: '累计获得积分',
  rules: '好友首次购买后数日内（且未退款）发放积分。仅新注册账户可以使用邀请。',
  recent: '最近邀请', none: '还没有人使用你的邀请。', joined: '加入时间',
  statusNames: { pending: '等待首次购买', granted: '已奖励', skipped: '不符合条件' },
};
export const referralCopy = (locale: string) => (locale.startsWith('zh') ? zh : en);
