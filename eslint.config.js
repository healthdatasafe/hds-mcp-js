import neostandard from 'neostandard';
import tseslint from 'typescript-eslint';

export default [
  // Global ignores — must be a standalone object (an `ignores` key combined
  // with other keys only scopes that config entry, it ignores nothing).
  { ignores: ['node_modules/', 'dist/', 'coverage/'] },
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
