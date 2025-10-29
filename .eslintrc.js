module.exports = {
  env: {
    es2021: true,
    node: true
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module' // Keep as module even if tsconfig says commonjs
  },
  plugins: [
    '@typescript-eslint'
  ],
  rules: {
    // You can add specific rule overrides here if needed
  },
  ignorePatterns: ['dist/**/*', 'node_modules/**/*'] // Ignore build output and node_modules
};