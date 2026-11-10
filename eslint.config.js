import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {languageOptions: {globals: {...globals.browser, ...globals.node, chrome: 'readonly'}}},
  {
    files: ['extension/**/*.ts'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', {assertionStyle: 'never'}],
      'no-restricted-syntax': [
        'error',
        {selector: 'ExportDefaultDeclaration', message: 'Use named exports.'},
      ],
    },
  },
];
