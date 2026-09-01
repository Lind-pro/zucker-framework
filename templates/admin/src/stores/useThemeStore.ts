import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ThemeState {
  themeMode: 'light' | 'dark';
  toggleTheme: () => void;
}

const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      themeMode: 'light',
      toggleTheme: () => set((s) => ({ themeMode: s.themeMode === 'light' ? 'dark' : 'light' })),
    }),
    { name: 'zucker-theme' },
  ),
);

export default useThemeStore;
