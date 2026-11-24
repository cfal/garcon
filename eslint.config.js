import ts from 'typescript-eslint';

export default [{
  ignores: ['**/node_modules/**', '**/__tests__/**'],
}, {
  files: ['server/remote/**/*.ts', 'server-agents/*/src/**/*.ts'],
  languageOptions: {
    parser: ts.parser,
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  plugins: { '@typescript-eslint': ts.plugin },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
  },
}];
