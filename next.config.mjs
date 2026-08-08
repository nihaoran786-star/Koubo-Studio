import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const isDesktopExport = process.env.NEXT_DESKTOP_EXPORT === '1'
const isDesktopBackend = process.env.NEXT_DESKTOP_BACKEND === '1'
const projectRoot = dirname(fileURLToPath(import.meta.url))

const nextConfig = {
  turbopack: {
    root: projectRoot,
  },
  serverExternalPackages: [
    'playwright-core',
  ],
  outputFileTracingExcludes: {
    '*': [
      './app/**/*',
      './components/**/*',
      './lib/**/*',
      './scripts/**/*',
      './tests/**/*',
      './data/**/*',
      './docs/**/*',
      './out/**/*',
      './public/**/*',
      './src-tauri/**/*',
      './.codex-screenshots/**/*',
      './.env*',
      './outside.*',
      './*.md',
      './*.ts',
      './*.tsx',
      './*.map',
    ],
  },
  outputFileTracingIncludes: {
    '*': [
      './agent-resources/**/*',
    ],
  },
  ...(isDesktopExport
    ? {
        output: 'export',
        trailingSlash: true,
      }
    : isDesktopBackend
      ? {
          output: 'standalone',
        }
    : {}),
  images: {
    unoptimized: true,
  },
}

export default nextConfig
