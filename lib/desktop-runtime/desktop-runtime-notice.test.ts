import { describe, expect, it } from 'vitest'
import { buildDesktopRuntimeNotices } from './desktop-runtime-notice'

describe('desktop runtime notices', () => {
  it('returns no notices before health is loaded', () => {
    expect(buildDesktopRuntimeNotices(undefined)).toEqual([])
  })

  it('maps unavailable desktop backend into an error notice', () => {
    expect(
      buildDesktopRuntimeNotices({
        status: 'unavailable',
        source: 'desktop_runtime',
        runtimeStatus: 'static_only',
        capabilities: [],
        requirements: [],
        error: {
          code: 'desktop_backend_missing',
          message: '桌面端生产包缺少本地后端。',
        },
      }),
    ).toEqual([
      {
        id: 'desktop_backend',
        title: '桌面端后端不可用',
        message: '桌面端生产包缺少本地后端。',
        tone: 'error',
      },
    ])
  })

  it('maps blocked script agent node runtime into a warning notice', () => {
    expect(
      buildDesktopRuntimeNotices({
        status: 'available',
        source: 'desktop_runtime',
        runtimeStatus: 'dev_server',
        capabilities: ['script_agent'],
        requirements: [
          {
            id: 'node_runtime',
            capability: 'script_agent',
            status: 'blocked',
            requiredVersion: '22.19.0',
            actualVersion: '20.20.0',
            error: {
              code: 'unsupported_node_version',
              message: '本地后端需要 Node >= 22.19.0，当前是 20.20.0',
            },
          },
        ],
      }),
    ).toEqual([
      {
        id: 'script_agent_node_runtime',
        title: 'AI 文案服务暂不可用',
        message:
          '本地后端需要 Node >= 22.19.0，当前是 20.20.0。请把本地后端 Node 升级到 22.19.0+，或在桌面打包时设置 DESKTOP_BACKEND_NODE_PATH。',
        tone: 'warning',
      },
    ])
  })
})
