import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    // The real-footage critique tests replay ten clips each; on a busy machine that outlasts the
    // 5 s default.
    testTimeout: 30_000,
  },
})
