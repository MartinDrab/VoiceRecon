'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'models/', 'data/', 'test/fixtures/'] },
  js.configs.recommended,
  {
    // Server, scripts and tests: CommonJS on Node.js.
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // Pages: ES modules in the browser, no build step.
    files: ['public/static/js/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // Loaded as a plain script before the stylesheet (see the file).
    files: ['public/static/js/boot.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['public/static/js/pcm-worklet.js'],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
      'no-implicit-coercion': ['error', { allow: ['!!'] }],
      'no-throw-literal': 'error',
      'no-return-assign': ['error', 'except-parens'],
    },
  },
];
