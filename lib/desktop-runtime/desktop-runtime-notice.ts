import type { DesktopRuntimeHealthResult, DesktopRuntimeRequirement } from './desktop-runtime-health'

export interface DesktopRuntimeNotice {
  id: string
  title: string
  message: string
  tone: 'warning' | 'error'
}

export function buildDesktopRuntimeNotices(
  health: DesktopRuntimeHealthResult | undefined,
): DesktopRuntimeNotice[] {
  if (!health) return []

  const notices: DesktopRuntimeNotice[] = []

  if (health.status === 'unavailable') {
    notices.push({
      id: 'desktop_backend',
      title: '桌面端后端不可用',
      message: health.error.message,
      tone: 'error',
    })
  }

  const blockedNode = health.requirements.find(isBlockedScriptAgentNodeRuntime)

  if (blockedNode) {
    notices.push({
      id: 'script_agent_node_runtime',
      title: 'AI 文案服务暂不可用',
      message:
        `${blockedNode.error.message}。请把本地后端 Node 升级到 ${blockedNode.requiredVersion}+，` +
        '或在桌面打包时设置 DESKTOP_BACKEND_NODE_PATH。',
      tone: 'warning',
    })
  }

  return notices
}

function isBlockedScriptAgentNodeRuntime(
  requirement: DesktopRuntimeRequirement,
): requirement is Extract<DesktopRuntimeRequirement, { status: 'blocked' }> {
  return (
    requirement.id === 'node_runtime' &&
    requirement.capability === 'script_agent' &&
    requirement.status === 'blocked'
  )
}
