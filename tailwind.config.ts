import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0f172a', // Dark theme background (slate-900)
        surface: '#1e293b',    // slate-800
        accent: '#f59e0b',     // Amber-500 accent color
        accentHover: '#d97706',
      },
      maxWidth: {
        player: '480px',
      },
    },
  },
  plugins: [],
};

export default config;
