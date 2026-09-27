import js from '@eslint/js';
import globals from 'globals';
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
    files: ['**/*.test.ts', '**/test/**', 'scripts/**', '**/*.config.*', 'app/**'],
    rules: { 'no-restricted-syntax': 'off' }
  }
);
