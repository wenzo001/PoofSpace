import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false }
    },
    // Every lane boots a real Node server and opens up to 101 websockets; running the files
    // concurrently starves the loopback accept queue and connects fail with 'socket error'
    // while the product is unchanged. Sequential files keep the assertions identical.
    fileParallelism: false,
    reporters: ['default'],
    coverage: { provider: 'v8', include: ['src/**/*.ts'] }
  },
  esbuild: {
    target: 'es2022'
  }
});
