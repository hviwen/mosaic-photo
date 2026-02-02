import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{vue,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: {
          bg: '#0b1020',
          panel: '#0f172a',
          border: 'rgba(255,255,255,0.08)',
        },
      },
    },
  },
  plugins: [],
} satisfies Config
