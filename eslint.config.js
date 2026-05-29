import neostandard from 'neostandard';
import tseslint from 'typescript-eslint';

export default [
  ...neostandard({ semi: true }),
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'off'
    },
    ignores: ['node_modules/', 'dist/', 'coverage/']
  }
];
