import { NextResponse } from 'next/server'
import {
  detectDesktopRuntimeHealth,
  type DesktopRuntimeHealthResult,
} from './desktop-runtime-health'
import { WorkspaceGuardError, assertSafeSegment } from '@/lib/workspaces/workspace-guard'

export async function handleDesktopRuntimeGet(options: {
  projectId: string
  runHealthCheck?: () => Promise<DesktopRuntimeHealthResult>
}) {
  try {
    assertSafeSegment(options.projectId, 'projectId')
    const result = await (options.runHealthCheck ?? (() =>
      detectDesktopRuntimeHealth({ projectId: options.projectId })))()
    return NextResponse.json(result, { status: result.status === 'available' ? 200 : 503 })
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return NextResponse.json(
        {
          status: 'unavailable',
          source: 'desktop_runtime',
          runtimeStatus: 'local_backend_failed',
          capabilities: [],
          requirements: [],
          error: {
            code: 'desktop_backend_unreachable',
            message: error.message,
          },
        },
        { status: 400 },
      )
    }

    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        status: 'unavailable',
        source: 'desktop_runtime',
        runtimeStatus: 'local_backend_failed',
        capabilities: [],
        requirements: [],
        error: {
          code: 'desktop_backend_unreachable',
          message,
        },
      },
      { status: 500 },
    )
  }
}
