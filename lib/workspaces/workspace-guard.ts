import path from 'node:path'

export function assertSafeSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new WorkspaceGuardError(`${label} 只能包含字母、数字、下划线和短横线`)
  }
  return value
}

export function assertInsideRoot(rootPath: string, targetPath: string): string {
  const resolvedRoot = path.resolve(rootPath)
  const resolvedTarget = path.resolve(targetPath)
  const relative = path.relative(resolvedRoot, resolvedTarget)

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedTarget
  }

  throw new WorkspaceGuardError('目标路径越过了当前项目工作区')
}

export class WorkspaceGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceGuardError'
  }
}
