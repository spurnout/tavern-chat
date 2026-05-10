/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Tavern palette: warm wood + candlelight, dark-mode first
        tavern: {
          ink: '#0c0a09',
          stone: '#1c1917',
          oak: '#292524',
          parchment: '#f5e9d3',
          ember: '#f97316',
          flame: '#fb923c',
          mead: '#fbbf24',
          forest: '#16a34a',
          mist: '#94a3b8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
