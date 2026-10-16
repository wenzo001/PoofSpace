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
    // `npm test` runs this include set in two invocations: everything except tests/perf, then
    // tests/perf. Sequential files reuse one child process, and the 100-member lane is the one
    // that pays for whatever the earlier files left behind in it - measured as a cascade in
    // reconnect churn -> large transfer -> storage hygiene (docs/DEBT.md D25). The two filters
    // are the same set by construction (`include` minus `tests/perf/**`, plus `tests/perf`), so
    // neither half can silently drop a file.
    reporters: ['default'],
    coverage: { provider: 'v8', include: ['src/**/*.ts'] }
  },
  esbuild: {
    target: 'es2022'
  }
});
