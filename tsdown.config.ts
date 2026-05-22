import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    scopes: 'src/scopes.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  platform: 'neutral',
  external: ['hono', '@hono/zod-openapi', 'zod'],
});
