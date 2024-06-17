module.exports = {
  root: true,
  plugins: [
    'no-only-tests'
  ],
  overrides: [
    {
      files: ['*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        project: require('path').join(__dirname, 'tsconfig.json')
      },
      extends: 'standard-with-typescript'
    }
  ],
  extends: ['standard'],
  // add your custom rules here
  rules: {
    // allow paren-less arrow functions
    'arrow-parens': 0
  }
}
