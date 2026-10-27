import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { yamlPlugin } from './build/yaml-plugin.ts'

export default defineConfig({
  plugins: [yamlPlugin()],
  resolve: {
    alias: {
      '@content': path.resolve('tests/fixtures/content'),
      '@': path.resolve('src'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
