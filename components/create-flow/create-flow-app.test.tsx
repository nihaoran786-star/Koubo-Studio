import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('CreateFlowApp governance boundary', () => {
  it('uses one overlay status entry instead of inline production and runtime cards', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'components/create-flow/create-flow-app.tsx'), 'utf8')

    expect(source).not.toContain('AgentTimelinePanel')
    expect(source).not.toContain("import('./agent-timeline-panel')")
    expect(source).toContain('FlowStatusPopover')
    expect(source).not.toContain("runtimeNotices.map((notice)")
    expect(source).not.toContain("activeRuntimeNotice && (\n                  <div")
    expect(source).not.toContain('onRenderReady')
  })

  it('does not register global arrow-key navigation that can bypass stage gates', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'components/create-flow/create-flow-app.tsx'), 'utf8')

    expect(source).not.toContain("addEventListener('keydown'")
    expect(source).not.toContain("removeEventListener('keydown'")
    expect(source).not.toContain('ArrowRight')
    expect(source).not.toContain('ArrowLeft')
    expect(source).not.toContain('handleKeyDown')
  })
})
