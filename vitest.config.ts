import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Persist the transform/deps cache under node_modules so CI can cache it
  // across runs (deps + vite transform results only change with the lockfile
  // or config, matching the setup-node cache key). Set at the Vite level —
  // vitest's own `test.cache.dir` is deprecated; its caches land in
  // cacheDir/vitest, still inside node_modules/.vitest for the CI cache.
  cacheDir: 'node_modules/.vitest',
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.worktrees/**',
    ],
    environmentMatchGlobs: [
      ['src/web/**', 'jsdom'],
    ],
    // Many of our web tests rely on React's test utilities (act, etc.).
    // If NODE_ENV is accidentally set to "production" in the environment,
    // React switches to the production build where act() is not supported.
    // Force a safe default so local/CI runs are stable.
    env: {
      NODE_ENV: process.env.NODE_ENV && process.env.NODE_ENV !== 'production' ? process.env.NODE_ENV : 'test',
    },
    // Some tests (live schema parity on fresh MySQL/Postgres containers,
    // dashboard perf cards under heavy parallel load) occasionally exceed
    // vitest's 5s default on slow CI runners. 10s still was not enough: the
    // dashboard observability suite renders VChart canvases and takes ~1.8s
    // standalone but >10s during a saturated full run. Budget for the loaded
    // case so load spikes do not turn into flaky failures.
    testTimeout: 30_000,
    // Suite hooks do heavier one-time work than individual tests: several
    // server-route suites run the real DB bootstrap (migrations + legacy
    // compat shims) inside `beforeAll` before registering Fastify. Under a
    // full parallel run that cold start can exceed vitest's 10s hook default,
    // which surfaces as a confusing `Cannot read properties of undefined
    // (reading 'close')` in `afterAll` (the hook timed out before `app` was
    // assigned). Give hooks a larger budget than tests.
    hookTimeout: 60_000,
  },
});
