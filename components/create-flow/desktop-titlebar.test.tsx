// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopTitlebar, shouldStartWindowDrag } from './desktop-titlebar'

const windowApi = {
  startDragging: vi.fn(async () => undefined),
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowApi,
}))

describe('DesktopTitlebar window dragging', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
  })

  it('starts native dragging from non-interactive titlebar content', async () => {
    renderTitlebar()
    const title = await screen.findByText('口播智能体')
    fireEvent.pointerDown(title, { button: 0 })
    await waitFor(() => expect(windowApi.startDragging).toHaveBeenCalledTimes(1))
  })

  it('does not drag when a navigation or window-control button is pressed', async () => {
    renderTitlebar()
    const productionTab = await screen.findByRole('button', { name: '生产' })
    fireEvent.pointerDown(productionTab, { button: 0 })
    fireEvent.pointerDown(screen.getByRole('button', { name: '最小化' }), { button: 0 })
    expect(windowApi.startDragging).not.toHaveBeenCalled()
  })

  it('accepts only the primary pointer on non-interactive elements', () => {
    const container = document.createElement('div')
    const button = document.createElement('button')
    container.append(button)
    expect(shouldStartWindowDrag(container, 0)).toBe(true)
    expect(shouldStartWindowDrag(container, 2)).toBe(false)
    expect(shouldStartWindowDrag(button, 0)).toBe(false)
  })
})

function renderTitlebar() {
  return render(
    <DesktopTitlebar
      active="overview"
      activeStep="idea"
      furthestStep={0}
      isDashboard
      onNavigate={vi.fn()}
      onStepSelect={vi.fn()}
      onBackToDashboard={vi.fn()}
    />,
  )
}
