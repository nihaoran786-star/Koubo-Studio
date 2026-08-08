type RuntimeEnv = Record<string, string | undefined>

declare global {
  interface Window {
    __KOUBO_API_BASE_URL__?: string
  }
}

export function readApiBaseUrl(env?: RuntimeEnv) {
  const rawValue = env
    ? env.NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL
    : readBrowserApiBaseUrl() || process.env.NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL
  const value = rawValue?.trim().replace(/\/+$/, '')
  return value || ''
}

export function buildApiEndpoint(path: string, env?: RuntimeEnv) {
  const baseUrl = readApiBaseUrl(env)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

export function buildProjectApiEndpoint(
  projectId: string,
  path: string,
  env?: RuntimeEnv,
) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return buildApiEndpoint(`/api/projects/${encodeURIComponent(projectId)}${normalizedPath}`, env)
}

function readBrowserApiBaseUrl() {
  const runtime = globalThis as typeof globalThis & {
    window?: {
      __KOUBO_API_BASE_URL__?: string
    }
  }
  return runtime.window?.__KOUBO_API_BASE_URL__ || ''
}
