import { theme, type ThemeConfig } from 'antd';

export function getThemeConfig(mode: 'light' | 'dark'): ThemeConfig {
  const isDark = mode === 'dark';

  return {
    algorithm: isDark ? [theme.darkAlgorithm] : [theme.defaultAlgorithm],

    token: {
      colorPrimary: '#4338CA',
      colorInfo: '#4338CA',
      colorSuccess: '#059669',
      colorWarning: '#D97706',
      colorError: '#DC2626',
      colorLink: '#4338CA',

      colorTextBase: isDark ? '#E2E8F0' : '#1E293B',
      colorBgBase: isDark ? '#0F172A' : '#FFFFFF',
      colorBgLayout: isDark ? '#020617' : '#F7F8FA',
      colorBorder: isDark ? '#334155' : '#E2E8F0',
      colorBorderSecondary: isDark ? '#1E293B' : '#F1F5F9',

      borderRadius: 8,
      borderRadiusSM: 6,
      borderRadiusLG: 12,

      fontFamily:
        '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 14,
      fontSizeHeading1: 30,
      fontSizeHeading2: 24,
      fontSizeHeading3: 20,
      fontSizeHeading4: 16,
      fontSizeHeading5: 14,

      controlHeight: 36,
      controlHeightLG: 44,
      controlHeightSM: 28,

      lineWidth: 1,

      boxShadow: isDark
        ? '0 1px 3px 0 rgba(0,0,0,0.3), 0 1px 2px -1px rgba(0,0,0,0.2)'
        : '0 1px 3px 0 rgba(0,0,0,0.04), 0 1px 2px -1px rgba(0,0,0,0.03)',
      boxShadowSecondary: isDark
        ? '0 4px 12px 0 rgba(0,0,0,0.4), 0 2px 4px -2px rgba(0,0,0,0.3)'
        : '0 4px 12px 0 rgba(0,0,0,0.06), 0 2px 4px -2px rgba(0,0,0,0.04)',

      padding: 16,
      paddingLG: 24,
      paddingSM: 12,
      paddingXS: 8,
      margin: 16,
      marginLG: 24,
      marginSM: 12,
      marginXS: 8,
    },

    components: {
      Layout: {
        headerBg: isDark ? '#0F172A' : '#FFFFFF',
        headerHeight: 56,
        siderBg: isDark ? '#0F172A' : '#FFFFFF',
        bodyBg: isDark ? '#020617' : '#F7F8FA',
        triggerBg: isDark ? '#1E293B' : '#F1F5F9',
      },
      Menu: {
        itemBg: 'transparent',
        itemSelectedBg: isDark ? 'rgba(67,56,202,0.15)' : '#EEF2FF',
        itemSelectedColor: '#818CF8',
        itemHoverBg: isDark ? 'rgba(255,255,255,0.04)' : '#F8FAFC',
        itemColor: isDark ? '#94A3B8' : '#64748B',
        itemActiveBg: isDark ? 'rgba(67,56,202,0.15)' : '#EEF2FF',
        subMenuItemBg: 'transparent',
        iconSize: 16,
        fontSize: 14,
        itemBorderRadius: 8,
        itemMarginInline: 8,
        itemHeight: 40,
      },
      Button: {
        borderRadius: 8,
        controlHeight: 36,
        controlHeightLG: 44,
        fontWeight: 500,
        primaryShadow: '0 2px 4px rgba(67, 56, 202, 0.2)',
      },
      Input: {
        controlHeight: 40,
        controlHeightLG: 48,
        borderRadius: 8,
        activeShadow: '0 0 0 3px rgba(67, 56, 202, 0.08)',
      },
      Select: {
        controlHeight: 40,
        borderRadius: 8,
      },
      Card: {
        borderRadiusLG: 12,
        paddingLG: 24,
        boxShadowTertiary: isDark
          ? '0 1px 3px rgba(0,0,0,0.3)'
          : '0 1px 3px rgba(0,0,0,0.04)',
      },
      Table: {
        headerBg: isDark ? '#1E293B' : '#FAFBFC',
        headerColor: isDark ? '#94A3B8' : '#64748B',
        headerSplitColor: isDark ? '#334155' : '#F1F5F9',
        rowHoverBg: isDark ? 'rgba(255,255,255,0.04)' : '#F8FAFC',
        borderColor: isDark ? '#1E293B' : '#F1F5F9',
        cellPaddingBlock: 14,
        cellPaddingInline: 16,
        fontSize: 14,
      },
      Tag: {
        borderRadiusSM: 6,
      },
      Modal: {
        borderRadiusLG: 16,
        paddingContentHorizontalLG: 28,
      },
      Pagination: {
        borderRadius: 8,
        itemActiveBg: '#4338CA',
      },
      Tabs: {
        inkBarColor: '#4338CA',
        itemSelectedColor: '#4338CA',
        itemHoverColor: '#6366F1',
      },
      Form: {
        labelFontSize: 14,
        labelColor: isDark ? '#94A3B8' : '#475569',
        itemMarginBottom: 24,
      },
      Statistic: {
        titleFontSize: 13,
        contentFontSize: 24,
      },
      Breadcrumb: {
        separatorColor: isDark ? '#475569' : '#CBD5E1',
        linkColor: isDark ? '#94A3B8' : '#64748B',
        lastItemColor: isDark ? '#E2E8F0' : '#1E293B',
      },
    },
  };
}

export default getThemeConfig('light');
