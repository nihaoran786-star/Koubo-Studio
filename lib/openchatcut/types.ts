export type OpenChatCutRuntimePhase =
  | 'not_installed'
  | 'downloading'
  | 'installer_ready'
  | 'installing'
  | 'installed'
  | 'launching'
  | 'external_instance'
  | 'mcp_ready'
  | 'failed'

export interface OpenChatCutError {
  code: string
  message: string
  stage?: string
  toolCode?: string
  recovery?: {
    action: 'inspect_and_discard'
    editSessionId: string
  }
}

export interface OpenChatCutRuntimeStatus {
  phase: OpenChatCutRuntimePhase
  installed: boolean
  installerReady: boolean
  mcpReady: boolean
  detail: string
  version: string
  download?: {
    received: number
    total?: number
    percent?: number
    stalled: boolean
  }
  error?: OpenChatCutError
}

export type OpenChatCutResult<T extends object = object> =
  | ({ status: 'ok'; source: 'openchatcut' } & T)
  | { status: 'error'; source: 'openchatcut'; error: OpenChatCutError }

export type OpenChatCutProjectPhase =
  | 'needs_user_import'
  | 'ready_to_draft'
  | 'drafting'
  | 'needs_review'
  | 'applied'
  | 'exporting'
  | 'exported'
  | 'rejected'
  | 'discarded'

export interface OpenChatCutProjectBridge {
  phase: OpenChatCutProjectPhase
  openChatCutProjectId: string
  editorUrl: string
  sourceVideoUrl: string
  sourceDurationSeconds: number
  sourceArtifactKind: 'render' | 'post-production'
  sourceArtifactId: string
  scriptArtifactId: string
  exportedArtifactId?: string
  exportedVideoUrl?: string
  instructions: string[]
  editSessionId?: string
}
