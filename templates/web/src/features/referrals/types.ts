export type ReferralStatus = 'pending' | 'granted' | 'skipped';
export type ReferralView =
  | { enabled: false; reason: 'disabled' | 'external-affiliate' | 'unavailable' }
  | {
      enabled: true;
      code: string;
      codeActive: boolean;
      link: string | null;
      stats: { invited: number; rewarded: number; creditsEarned: number };
      recent: Array<{ boundAt: string; status: ReferralStatus }>;
    };
