'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PublishPlatformId } from '@/lib/artifacts/publish-package-artifact'
import type { BrowserPublishSnapshot } from './browser'
import { createBrowserPublishClient } from './browser-publish-client'

export function useBrowserPublish(projectId: string) {
  const client = useMemo(() => createBrowserPublishClient(), [])
  const [snapshot, setSnapshot] = useState<BrowserPublishSnapshot>({
    status: 'idle', source: 'visible_browser', updatedAt: new Date().toISOString(),
  })
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setSnapshot({ status: 'idle', source: 'visible_browser', updatedAt: new Date().toISOString() })
    setBusy(true)
    void client.get(projectId).then((result) => {
      if (generation.current === current) setSnapshot(result)
    }).finally(() => {
      if (generation.current === current) setBusy(false)
    })
    return () => { generation.current += 1 }
  }, [client, projectId])

  async function run(operation: () => Promise<BrowserPublishSnapshot>) {
    const current = generation.current
    setBusy(true)
    try {
      const result = await operation()
      if (generation.current === current) setSnapshot(result)
      return result
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }

  return {
    snapshot,
    busy,
    load: () => run(() => client.get(projectId)),
    open: (artifactId: string, platformId: PublishPlatformId) => run(() => client.open({ projectId, artifactId, platformId })),
    refresh: () => run(() => client.refresh(projectId)),
    fill: (artifactId: string, platformId: PublishPlatformId) => run(() => client.fill({ projectId, artifactId, platformId })),
    close: () => run(() => client.close(projectId)),
  }
}
