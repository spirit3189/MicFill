import eslint from '@eslint/js';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'outputs/**', 'work/**', 'node_modules/**', '.omx/**'],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslint,
    },
    rules: {
      ...typescriptEslint.configs.recommended.rules,
      // TypeScript resolves browser, worker, and Chrome globals from tsconfig types.
      'no-undef': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      globals: {
        structuredClone: 'readonly',
      },
    },
  },
  {
    files: ['src/offscreen/audio-worklet.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },
];
