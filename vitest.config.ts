import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [
      'node_modules/**',
      '.next/**',
      'tests/e2e/**',
      'src-tauri/resources/koubo-backend/**',
      'src-tauri/.target/**',
      'src-tauri/target/**',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
})
