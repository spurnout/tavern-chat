/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Semantic color tokens — see ../../docs/design-system.html.
      // Canonical values live in src/styles.css as CSS custom properties;
      // the references here are how Tailwind generates utilities.
      colors: {
        // Surfaces — flat names so utilities read as bg-canvas, bg-surface, etc.
        canvas:   'var(--bg-canvas)',
        sunken:   'var(--bg-sunken)',
        surface:  'var(--bg-surface)',
        raised:   'var(--bg-raised)',
        elevated: 'var(--bg-elevated)',
        overlay:  'var(--bg-overlay)',

        // Foregrounds — text-fg, text-fg-muted, text-fg-faint, text-fg-on-accent
        fg: {
          DEFAULT: 'var(--fg-default)',
          muted: 'var(--fg-muted)',
          faint: 'var(--fg-faint)',
          'on-accent': 'var(--fg-on-accent)',
        },

        // Accents — bg-ember, text-ember, bg-ember-hi, etc.
        ember: {
          DEFAULT: 'var(--ember)',
          hi: 'var(--ember-hi)',
          lo: 'var(--ember-lo)',
        },
        mead:     'var(--mead)',
        moss:     'var(--moss)',
        rust:     'var(--rust)',
        lavender: 'var(--lavender)',
        dusk:     'var(--dusk)',

        // Destructive status — text-danger, bg-danger, hover:bg-danger-hi.
        danger: {
          DEFAULT: 'var(--danger)',
          hi: 'var(--danger-hi)',
        },
      },

      // Borders — namespaced separately so utilities read as border-subtle,
      // border-default, border-strong (not border-border-*, which would
      // happen if these lived under colors). Bare `border` (no suffix)
      // also uses --border-subtle so adding a border without a tier still
      // looks correct.
      borderColor: {
        DEFAULT: 'var(--border-subtle)',
        subtle:  'var(--border-subtle)',
        default: 'var(--border-default)',
        strong:  'var(--border-strong)',
        danger:  'var(--border-danger)',
      },

      // Tint backgrounds — bg-tint-ember, bg-tint-fg-04, etc.
      backgroundColor: {
        'tint-ember':    'var(--tint-ember)',
        'tint-mead':     'var(--tint-mead)',
        'tint-moss':     'var(--tint-moss)',
        'tint-rust':     'var(--tint-rust)',
        'tint-lavender': 'var(--tint-lavender)',
        'tint-dusk':     'var(--tint-dusk)',
        'tint-fg-04':    'var(--tint-fg-04)',
        'tint-danger':   'var(--tint-danger)',
      },

      // Type families — sans/serif/mono match the design-system spec.
      // Loaded in index.html via Google Fonts; system fallbacks listed.
      fontFamily: {
        sans: ['Manrope', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        serif: ['"Source Serif 4"', 'ui-serif', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
