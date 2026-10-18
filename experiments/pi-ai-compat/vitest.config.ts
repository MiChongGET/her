import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['experiments/pi-ai-compat/*.test.ts'], testTimeout: 15000, hookTimeout: 10000, fileParallelism: false },
})
