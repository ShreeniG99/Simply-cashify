import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The MCP integration test spawns a real subprocess and runs full
    // reconciliations (including the 6-rung ablation sweep) over stdio; this
    // sandbox's CPU allocation has been observed to vary significantly
    // session to session (see README's environmental performance note), so
    // the default 5s per-test timeout is too tight for that one file.
    testTimeout: 20_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
})
