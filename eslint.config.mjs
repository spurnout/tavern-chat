import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';

// jsx-a11y runs at its recommended severities (the load-bearing rules are
// errors). A handful are softened because they fight the codebase's deliberate,
// valid patterns or track out-of-scope feature work — justified per rule so a
// future reader knows these are choices, not oversights.
const jsxA11ySoftened = {
  // Deprecated rule; double-flags the valid `<label><span/><input/></label>`
  // nesting the app uses everywhere. `label-has-associated-control` covers it.
  'jsx-a11y/label-has-for': 'off',
  // The nested-label pattern is accessible but trips this rule's strict mode.
  'jsx-a11y/label-has-associated-control': 'warn',
  'jsx-a11y/control-has-associated-label': 'warn',
  // <video>/<audio> caption tracks are feature work (watch party, voice).
  'jsx-a11y/media-has-caption': 'warn',
  // Deliberate, focused use inside dialogs and the command palette.
  'jsx-a11y/no-autofocus': 'warn',
  // Pre-existing affordances (backdrops, row interactions) — triage separately.
  'jsx-a11y/no-noninteractive-element-interactions': 'warn',
  'jsx-a11y/no-static-element-interactions': 'warn',
  'jsx-a11y/no-noninteractive-tabindex': 'warn',
  'jsx-a11y/click-events-have-key-events': 'warn',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/prisma/migrations/**',
      '**/*.config.{js,cjs,mjs,ts}',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-unused-vars': 'off',
    },
  },
  // React hooks rules — scoped to the web app where hooks are used.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Accessibility linting — scoped to the web app. Recommended rules at their
  // default (error) severity, minus the softened set above.
  // @typescript-eslint/parser detects JSX automatically for .tsx.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: {
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      ...jsxA11ySoftened,
    },
  },
  // Block reintroduction of the deprecated tavern-* Tailwind classes.
  // The design-system migration removed them; see docs/design-system.html.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/\\btavern-[a-z]/]",
          message:
            'tavern-* Tailwind classes were removed in the design-system migration. Use the new tokens (bg-canvas, text-fg, border-subtle, bg-ember, etc). See docs/design-system.html.',
        },
        {
          selector:
            "JSXAttribute[name.name='className'] TemplateElement[value.raw=/\\btavern-[a-z]/]",
          message:
            'tavern-* Tailwind classes were removed in the design-system migration. Use the new tokens (bg-canvas, text-fg, border-subtle, bg-ember, etc). See docs/design-system.html.',
        },
      ],
    },
  },
  prettier,
];
