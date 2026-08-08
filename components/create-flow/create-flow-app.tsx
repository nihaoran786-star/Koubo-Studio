'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft } from 'lucide-react'
import { CHAMBERS, type ChamberId } from '@/lib/chambers'
import { ChamberTrack } from './chamber-track'
import { DesktopTitlebar } from './desktop-titlebar'
import { AppPageFrame } from './app-page-frame'
import { Dashboard } from '@/components/dashboard/dashboard'
import { TopNav, type NavId } from '@/components/dashboard/top-nav'
import type { Project } from '@/lib/projects'
import { useWorkspace } from '@/lib/workspace'
import { buildDesktopRuntimeNotices } from '@/lib/desktop-runtime/desktop-runtime-notice'
import { useDesktopRuntime } from '@/lib/desktop-runtime/use-desktop-runtime'
import { buildRuntimeReadinessNotice } from '@/lib/runtime-readiness/runtime-readiness-notice'
import { useRuntimeReadiness } from '@/lib/runtime-readiness/use-runtime-readiness'
import { resolveReturnToCreateTarget, type ReturnToCreateTarget } from '@/lib/create-flow/return-to-create'
import { cn } from '@/lib/utils'
import { FlowStatusPopover } from './flow-status-popover'

type View = 'dashboard' | 'create'

const loadingStage = () => <div className="grid min-h-64 place-items-center text-sm text-sub">正在打开…</div>
const IdeaChamber = dynamic(() => import('./idea-chamber').then((module) => module.IdeaChamber), { loading: loadingStage })
const VoiceChamber = dynamic(() => import('./voice-chamber').then((module) => module.VoiceChamber), { loading: loadingStage })
const AvatarChamber = dynamic(() => import('./avatar-chamber').then((module) => module.AvatarChamber), { loading: loadingStage })
const RenderChamber = dynamic(() => import('./render-chamber').then((module) => module.RenderChamber), { loading: loadingStage })
const PublishChamber = dynamic(() => import('./publish-chamber').then((module) => module.PublishChamber), { loading: loadingStage })
const SettingsPage = dynamic(() => import('@/components/settings/settings-page').then((module) => module.SettingsPage), { loading: loadingStage })

export function CreateFlowApp() {
  const [view, setView] = useState<View>('dashboard')
  const [nav, setNav] = useState<NavId>('overview')
  const [active, setActive] = useState<ChamberId>('idea')
  const [furthest, setFurthest] = useState(0)
  const [dir, setDir] = useState(1)
  const [isDesktopShell, setIsDesktopShell] = useState(false)
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [returnToCreate, setReturnToCreate] = useState<ReturnToCreateTarget | null>(null)
  const workspace = useWorkspace()
  const desktopRuntime = useDesktopRuntime(activeProjectId ?? undefined)
  const runtimeReadiness = useRuntimeReadiness()

  const activeIndex = CHAMBERS.find((c) => c.id === active)!.index

  useEffect(() => {
    if (view === 'create' && activeProjectId) {
      void desktopRuntime.checkHealth(activeProjectId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activeProjectId])

  function goTo(id: ChamberId) {
    const target = CHAMBERS.find((c) => c.id === id)!.index
    setDir(target >= activeIndex ? 1 : -1)
    setActive(id)
    setFurthest((f) => Math.max(f, target))
    if (activeProjectId) {
      workspace.updateProjectStep(activeProjectId, id, target)
    }
  }

  function next() {
    const n = CHAMBERS[Math.min(activeIndex + 1, CHAMBERS.length - 1)]
    goTo(n.id)
  }
  function prev() {
    const p = CHAMBERS[Math.max(activeIndex - 1, 0)]
    goTo(p.id)
  }

  async function startCreate(p?: Project) {
    const projectId = p?.id ?? await workspace.createProject()
    setActiveProjectId(projectId)
    setReturnToCreate(null)
    if (p?.step) {
      const target = CHAMBERS[Math.min(p.step - 1, CHAMBERS.length - 1)]
      setActive(target.id)
      setFurthest(Math.max(target.index, (p.furthestStep ?? p.step) - 1))
    } else {
      setActive('idea')
      setFurthest(0)
    }
    setView('create')
  }

  function handleNavigate(id: NavId) {
    if (id === 'create') {
      void startCreate()
      return
    }
    if (id === 'settings' && view === 'create' && activeProjectId) {
      setReturnToCreate({ projectId: activeProjectId, chamberId: active })
    } else if (id !== 'settings') {
      setReturnToCreate(null)
    }
    setNav(id)
    setView('dashboard')
  }

  function openRuntimeSettings() {
    if (activeProjectId) {
      setReturnToCreate({ projectId: activeProjectId, chamberId: active })
    }
    setNav('settings')
    setView('dashboard')
  }

  function resumeCreateFromSettings() {
    const target = resolveReturnToCreateTarget(
      returnToCreate,
      workspace.projects.map((project) => project.id),
    )
    if (!target) {
      setReturnToCreate(null)
      setNav('overview')
      return
    }

    setActiveProjectId(target.projectId)
    setDir(target.chamberIndex >= activeIndex ? 1 : -1)
    setActive(target.chamberId)
    setFurthest((value) => Math.max(value, target.chamberIndex))
    workspace.updateProjectStep(target.projectId, target.chamberId, target.chamberIndex)
    setReturnToCreate(null)
    setView('create')
  }

  const focus = nav === 'projects' ? 'projects' : nav === 'settings' ? 'settings' : 'overview'
  const activeProject = activeProjectId
    ? workspace.projects.find((project) => project.id === activeProjectId)
    : undefined
  const runtimeNotices = buildDesktopRuntimeNotices(desktopRuntime.health)
  const activeRuntimeNotice = buildRuntimeReadinessNotice(runtimeReadiness.result, active)
  const resolvedReturnToCreate = resolveReturnToCreateTarget(
    returnToCreate,
    workspace.projects.map((project) => project.id),
  )
  const returnChamber = resolvedReturnToCreate
    ? CHAMBERS.find((chamber) => chamber.id === resolvedReturnToCreate.chamberId)
    : undefined

  return (
    <div className="flex h-dvh flex-col bg-background grid-bg">
      <DesktopTitlebar
        active={nav}
        activeStep={active}
        furthestStep={furthest}
        isDashboard={view === 'dashboard'}
        onNavigate={handleNavigate}
        onStepSelect={goTo}
        onBackToDashboard={() => setView('dashboard')}
        onDetected={setIsDesktopShell}
      />
      {view === 'dashboard' && !isDesktopShell && (
        <TopNav
          active={nav}
          onNavigate={handleNavigate}
        />
      )}

      <main className="flex min-h-0 flex-1 flex-col">
        {view === 'dashboard' ? (
          <div className="flex-1 overflow-y-auto">
            {focus === 'settings' ? (
              <SettingsPage
                returnToCreate={
                  resolvedReturnToCreate
                    ? {
                        label: `返回当前创作 · ${returnChamber?.zh ?? '创作'}`,
                        onClick: resumeCreateFromSettings,
                      }
                    : undefined
                }
              />
            ) : (
              <Dashboard
                projects={workspace.projects}
                ready={workspace.ready}
                workspaceStatus={workspace.status}
                workspaceError={workspace.error}
                onRetry={workspace.retry}
                onCreate={() => startCreate()}
                onOpenProject={startCreate}
                onViewAll={() => setNav('projects')}
                focus={focus}
              />
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* ultra-thin floating top bar */}
            <div className={cn('fixed left-0 right-0 z-30 h-11 items-center px-3 md:px-6', isDesktopShell ? 'hidden' : 'top-0 flex')}>
              <div className="absolute inset-0 bg-background/60 backdrop-blur-xl" />
              {/* back icon */}
              <button
                onClick={() => setView('dashboard')}
                aria-label="返回工作台"
                className="relative flex size-7 items-center justify-center rounded-full text-sub/70 transition-colors hover:bg-secondary hover:text-foreground"
              >
                <ChevronLeft className="size-[15px]" strokeWidth={2} />
              </button>
              {/* centered step label */}
              <div className="absolute inset-x-0 flex items-center justify-center pointer-events-none">
                <AnimatePresence mode="wait">
                  <motion.span
                    key={active}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.2 }}
                    className="relative font-mono text-[11px] tracking-widest text-sub/60"
                  >
                    {CHAMBERS.find((c) => c.id === active)?.zh ?? ''}
                  </motion.span>
                </AnimatePresence>
              </div>
            </div>

            {activeProject && (
              <FlowStatusPopover
                projectId={activeProject.id}
                runtimeNotices={runtimeNotices}
                activeRuntimeNotice={activeRuntimeNotice}
                isDesktopShell={isDesktopShell}
                onOpenSettings={openRuntimeSettings}
              />
            )}

            {/* scrollable create stage — top padding clears floating bar, bottom clears track */}
            <div className={cn('flex-1', active === 'idea' ? 'overflow-hidden' : 'overflow-y-auto')}>
              <AppPageFrame
                compact
                className={cn(
                  active === 'idea' && 'h-full min-h-0',
                  !isDesktopShell && 'pt-14',
                  isDesktopShell ? 'pb-8' : 'pb-32',
                )}
              >
                <AnimatePresence mode="wait" custom={dir}>
                  <motion.div
                    key={active}
                    custom={dir}
                    initial={{ opacity: 0, x: dir * 60 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: dir * -60 }}
                    transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
                    className={cn(active === 'idea' && 'min-h-0 flex-1')}
                  >
                    {active === 'idea' && activeProject && (
                      <IdeaChamber
                        projectId={activeProject.id}
                        script={activeProject.script}
                        onChange={(script) => workspace.updateScript(activeProject.id, script)}
                        onNext={next}
                        onOpenSettings={openRuntimeSettings}
                      />
                    )}
                    {active === 'voice' && activeProject && (
                      <VoiceChamber
                        projectId={activeProject.id}
                        scriptArtifactId={activeProject.script.artifactId}
                        scriptText={activeProject.script.body || activeProject.script.topic}
                        onAudioReady={(artifactId) => workspace.updateSelectedAudioArtifact(activeProject.id, artifactId)}
                        onNext={next}
                        onPrev={prev}
                      />
                    )}
                    {active === 'avatar' && activeProject && (
                      <AvatarChamber
                        projectId={activeProject.id}
                        scriptArtifactId={activeProject.script.artifactId}
                        audioArtifactId={activeProject.selectedAudioArtifactId}
                        onNext={next}
                        onPrev={prev}
                        onOpenSettings={openRuntimeSettings}
                      />
                    )}
                    {active === 'render' && activeProject && (
                      <RenderChamber
                        projectId={activeProject.id}
                        renderArtifactId={activeProject.selectedRenderArtifactId}
                        postProductionArtifactId={activeProject.selectedPostProductionArtifactId}
                        onNext={next}
                        onPrev={prev}
                        onPostProductionReady={(artifactId) =>
                          workspace.updateSelectedPostProductionArtifact(activeProject.id, artifactId)
                        }
                      />
                    )}
                    {active === 'publish' && activeProject && (
                      <PublishChamber
                        projectId={activeProject.id}
                        postProductionArtifactId={activeProject.selectedPostProductionArtifactId}
                        selectedPublishPackageArtifactId={activeProject.selectedPublishPackageArtifactId}
                        script={activeProject.script}
                        onPrev={prev}
                      />
                    )}
                  </motion.div>
                </AnimatePresence>
              </AppPageFrame>
            </div>

            {/* step track — fixed to bottom of viewport */}
            <div className={cn('fixed bottom-0 left-0 right-0 z-20 border-t border-line/60 bg-background/90 px-4 py-4 backdrop-blur-xl md:px-8', isDesktopShell && 'hidden')}>
              <div className="mx-auto max-w-5xl">
                <ChamberTrack active={active} furthest={furthest} onSelect={goTo} />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
