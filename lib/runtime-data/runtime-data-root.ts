import path from 'node:path'

export function getRuntimeDataRoot() {
  const configured = process.env.KOUBO_APP_DATA_ROOT?.trim()
  return configured
    ? path.resolve(configured)
    : path.join(/*turbopackIgnore: true*/ process.cwd(), 'data')
}

export function getRuntimeSettingsRoot() {
  return path.join(/*turbopackIgnore: true*/ getRuntimeDataRoot(), 'settings')
}
