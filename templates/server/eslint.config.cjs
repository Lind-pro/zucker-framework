const parser = require('@typescript-eslint/parser');
const plugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'src/generated/**', 'uploads/**', 'coverage/**', '**/*.tsbuildinfo'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    plugins: { '@typescript-eslint': plugin },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-debugger': 'error',
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'no-eval': 'error',
    },
  },
];
