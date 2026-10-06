import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import'],
  categories: {
    correctness: 'error',
    suspicious: 'error',
    perf: 'error',
    pedantic: 'error',
  },
  ignorePatterns: [
    'dist/**',
    'coverage/**',
    '.vitest/**',
    '.agent/**',
    '.agents/**',
    '.claude/**',
    '.codex/**',
    '.continue/**',
    '.cursor/**',
    '.gemini/**',
    '.opencode/**',
    '.pi/**',
    '.roo/**',
    '.windsurf/**',
  ],
  // `effect/index.ts` (5 Effect rules) is not registered: no Effect dependency in this repo.
  jsPlugins: [{ name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' }],
  rules: {
    'eslint/curly': ['error', 'all'],
    'eslint/no-else-return': ['error', { allowElseIf: false }],
    'eslint/func-style': ['error', 'declaration', { allowTypeAnnotation: true }],
    // `{}` is the deliberate identity for accumulated vars / base config generics.
    'typescript/ban-types': 'off',
    // Router/handler builders are single closures by design; size is a review concern.
    'eslint/max-lines-per-function': 'off',
    // Patterns are ASCII-only; `u` mode rejects the literal `{` in the OpenAPI path converter.
    'eslint/require-unicode-regexp': 'off',
    // `lib` is ES2022, so `toSorted` is unavailable.
    'unicorn/no-array-sort': 'off',

    'oxc/no-accumulating-spread': 'error',
    'anti-slop/no-array-filter-map': 'error',
    'anti-slop/no-reduce-accumulator-copy': 'error',
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-runtime-typeof': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/prefer-early-return': 'error',
    'anti-slop/require-readable-spacing': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
  },
  overrides: [
    {
      // Runtime boundary: deep-merges untyped route config and probes Zod schemas structurally.
      files: ['src/router/create-router.ts', 'src/router/deep-merge.ts'],
      rules: {
        'anti-slop/no-runtime-typeof': 'off',
        'anti-slop/no-unknown-parameters': 'off',
        'anti-slop/no-unknown-returns': 'off',
        'anti-slop/no-unsafe-dictionary-type': 'off',
        'anti-slop/no-known-value-widening': 'off',
      },
    },
    {
      // Proxy over `c.req.valid`: keys are any `PropertyKey`; `ValidatedProxy` types the values.
      files: ['src/handler/handle.ts'],
      rules: {
        'anti-slop/no-runtime-typeof': 'off',
        'anti-slop/no-unknown-returns': 'off',
        'anti-slop/no-unsafe-dictionary-type': 'off',
        // `HandlerInvocation` is intentionally thenable.
        'unicorn/no-thenable': 'off',
      },
    },
    {
      // Phantom-typed context augmentation: runtime shape is erased, types come from the kind `K`.
      files: ['src/definitions/extend.ts'],
      rules: {
        'anti-slop/no-chained-type-assertions': 'off',
        'anti-slop/no-unknown-parameters': 'off',
        'anti-slop/no-unknown-returns': 'off',
        'anti-slop/no-unsafe-dictionary-type': 'off',
        'anti-slop/no-known-value-widening': 'off',
      },
    },
    {
      // `onForbidden` returns a caller-defined JSON body; `security` entries are parsed here.
      files: ['src/scopes.ts'],
      rules: {
        'anti-slop/no-runtime-typeof': 'off',
        'anti-slop/no-unknown-returns': 'off',
      },
    },
    {
      // Error arms are tried in order and the first match wins, so awaits must be sequential.
      files: ['src/errors/error-arms.ts'],
      rules: { 'eslint/no-await-in-loop': 'off' },
    },
    {
      // Tests fabricate fixtures, read untyped `res.json()`, and stub Promise-returning signatures.
      files: ['src/**/*.test.ts', 'src/**/*.test-d.ts'],
      rules: {
        'anti-slop/require-safety-comment-for-type-assertion': 'off',
        'anti-slop/no-chained-type-assertions': 'off',
        'anti-slop/no-unknown-parameters': 'off',
        'anti-slop/no-unknown-returns': 'off',
        'anti-slop/no-unsafe-dictionary-type': 'off',
        'anti-slop/no-known-value-widening': 'off',
        // Stubs must match Promise-returning handler/middleware signatures.
        'eslint/require-await': 'off',
        // Factory callback params (`router`, `route`) mirror the API names on purpose.
        'eslint/no-shadow': 'off',
        // One describe-file per module; long suites are expected.
        'eslint/max-lines': 'off',
        // Error-class fixtures live beside the tests that use them.
        'eslint/max-classes-per-file': 'off',
        // Tests throw non-Errors on purpose to cover the rethrow path.
        'eslint/no-throw-literal': 'off',
        // Helpers stay inside the test block that owns them.
        'unicorn/consistent-function-scoping': 'off',
        // Explicit `undefined` args and wrapped callbacks pin the overload/inference under test.
        'unicorn/no-useless-undefined': 'off',
        // `(id) => Number(id)` pins the callback parameter type under test.
        'unicorn/prefer-native-coercion-functions': 'off',
        // `if (res.status === 200) { ... }` narrows the response type for the assertions inside.
        'anti-slop/prefer-early-return': 'off',
        // Bare `{ }` blocks scope each case. ES modules are strict, so a function declared in a
        // block is scoped to that block.
        'eslint/no-inner-declarations': ['error', 'functions', { blockScopedFunctions: 'allow' }],
      },
    },
    {
      // Vendored upstream source: keep correctness/suspicious/perf; skip house style and self-lint.
      files: ['tools/oxlint/anti-slop/**'],
      rules: {
        // Upstream uses the `!= null` idiom.
        'eslint/eqeqeq': ['error', 'always', { null: 'ignore' }],
        // Upstream structure (large rule files, AST `_`-fields, helper layout) is kept as-is.
        'eslint/max-lines': 'off',
        'eslint/no-shadow': 'off',
        'eslint/no-underscore-dangle': 'off',
        'import/max-dependencies': 'off',
        'unicorn/consistent-function-scoping': 'off',
        'unicorn/no-array-callback-reference': 'off',
        'unicorn/no-immediate-mutation': 'off',
        // Upstream code style is kept as-is.
        'eslint/curly': 'off',
        'eslint/no-else-return': 'off',
        'eslint/func-style': 'off',
        // The plugin's own source is not held to its rules (upstream does not self-apply them).
        'anti-slop/no-array-filter-map': 'off',
        'anti-slop/no-reduce-accumulator-copy': 'off',
        'anti-slop/no-chained-type-assertions': 'off',
        'anti-slop/no-conditional-empty-object-spread': 'off',
        'anti-slop/no-known-value-widening': 'off',
        'anti-slop/no-module-mocking': 'off',
        'anti-slop/no-object-parameters': 'off',
        'anti-slop/no-reflect-apply': 'off',
        'anti-slop/no-reflect-get': 'off',
        'anti-slop/no-runtime-typeof': 'off',
        'anti-slop/no-shape-in-symbol-names': 'off',
        'anti-slop/no-unknown-parameters': 'off',
        'anti-slop/no-unknown-returns': 'off',
        'anti-slop/no-unknown-type-aliases': 'off',
        'anti-slop/no-unsafe-dictionary-type': 'off',
        'anti-slop/no-widen-then-assert': 'off',
        'anti-slop/prefer-early-return': 'off',
        'anti-slop/require-readable-spacing': 'off',
        'anti-slop/require-safety-comment-for-type-assertion': 'off',
      },
    },
  ],
});
