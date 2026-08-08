type Fetcher = typeof fetch

export interface ApiClientError {
  code: 'desktop_backend_missing'
  message: string
}

export async function requestJson<T>(
  input: RequestInfo | URL,
  options: {
    fetcher?: Fetcher
    init?: RequestInit
    fallback: (error: ApiClientError) => T
  },
): Promise<T> {
  try {
    const response = await (options.fetcher ?? fetch)(input, options.init)
    return (await response.json()) as T
  } catch {
    return options.fallback({
      code: 'desktop_backend_missing',
      message: '无法连接项目后端。桌面端生产包需要 local backend 或 sidecar 承载 API。',
    })
  }
}

