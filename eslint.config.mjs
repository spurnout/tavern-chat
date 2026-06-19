import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';

// jsx-a11y's recommended set, downgraded to `warn` for the rollout (preserving
// each rule's options). Phase 2 of the design-critique remediation flips the
// load-bearing rules back to `error`; until then a11y findings surface as
// warnings so they don't block unrelated work.
const jsxA11yWarn = Object.fromEntries(
  Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule, setting]) => [
    rule,
    Array.isArray(setting) ? ['warn', ...setting.slice(1)] : 'warn',
  ]),
);

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
  // Accessibility linting — scoped to the web app. Warn-level during the
  // design-critique remediation rollout; Phase 2 promotes the key rules to
  // error. @typescript-eslint/parser detects JSX automatically for .tsx.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: {
      'jsx-a11y': jsxA11y,
    },
    rules: jsxA11yWarn,
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
