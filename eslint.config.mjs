import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

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
