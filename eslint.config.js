import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.aws-sam/**',
      '**/.build/**',
      'app/test-results/**',
      'app/playwright-report/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Use ctx.clock.now() (see docs/ARCHITECTURE.md) so the simulator can control time.'
        }
      ]
    }
  },
  {
    // The SPA runs in the browser and follows the rules of hooks.
    files: ['app/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    files: ['**/*.test.ts', '**/test/**', 'scripts/**', '**/*.config.*', 'app/**'],
    rules: { 'no-restricted-syntax': 'off' }
  }
);
