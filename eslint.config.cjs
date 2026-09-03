const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  // ─── Global ignores ────────────────────────────────────────────────
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/coverage/**',
    ],
  },

  // ─── TypeScript files ──────────────────────────────────────────────
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // --- @typescript-eslint/recommended (hand-picked for flat config) ---
      'no-undef': 'off', // TS handles this
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-interface': 'warn',
      '@typescript-eslint/no-inferrable-types': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // --- Code quality ---
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-template-curly-in-string': 'warn',
      'prefer-const': 'warn',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'no-throw-literal': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',

      // --- Framework-specific: prevent hardcoded secrets ---
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'Literal[value=/default-secret|password123|admin123/i]',
          message:
            'Avoid hardcoded secrets or default passwords. Use environment variables instead.',
        },
        {
          selector:
            'MemberExpression[object.name="process"][property.name="env"]',
          message:
            'Avoid direct process.env access in library packages. Use NestJS ConfigService or module options instead.',
        },
      ],
    },
  },

  // ─── Test files: relaxed rules ─────────────────────────────────────
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // ─── Template apps: allow process.env ──────────────────────────────
  {
    files: ['templates/**/src/**/*.ts', 'templates/**/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-console': 'off',
    },
  },
];
