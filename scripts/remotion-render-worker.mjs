import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { bundle } from '@remotion/bundler'
import {
  ensureBrowser,
  renderMedia,
  selectComposition,
} from '@remotion/renderer'

const manifestPath = path.resolve(process.argv[2] ?? '')
if (!manifestPath) throw new Error('Missing Remotion render manifest path.')

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
const stagingDirectory = path.dirname(manifestPath)
const entryPoint = path.resolve(process.cwd(), 'remotion', 'index.tsx')
const outputLocation = path.resolve(manifest.outputLocation)
const inputPath = path.resolve(manifest.inputPath)
const stagedInputPath = path.join(stagingDirectory, 'input.mp4')

await fs.copyFile(inputPath, stagedInputPath)
await writeEditPulse(path.join(stagingDirectory, 'edit-pulse.wav'))
const serveUrl = await bundle({
  entryPoint,
  publicDir: stagingDirectory,
  webpackOverride: (configuration) => configuration,
})
const browser = await ensureBrowser({
  chromeMode: 'headless-shell',
  logLevel: 'warn',
})
if (browser.type === 'no-browser' || browser.type === 'version-mismatch') {
  throw new Error('Remotion browser runtime is unavailable.')
}
const browserExecutable = browser.path
const composition = await selectComposition({
  serveUrl,
  id: 'KouboAutoEdit',
  inputProps: manifest.props,
  browserExecutable,
  chromeMode: 'headless-shell',
  logLevel: 'warn',
})
await renderMedia({
  serveUrl,
  composition,
  inputProps: manifest.props,
  codec: 'h264',
  audioCodec: 'aac',
  outputLocation,
  browserExecutable,
  chromeMode: 'headless-shell',
  overwrite: true,
  pixelFormat: 'yuv420p',
  concurrency: Math.max(1, Math.min(4, Number(manifest.concurrency) || 2)),
  crf: 18,
  x264Preset: 'medium',
  logLevel: 'warn',
  licenseKey: process.env.REMOTION_LICENSE_KEY?.trim() || null,
})

process.stdout.write(`${JSON.stringify({ status: 'ok', outputLocation })}\n`)

async function writeEditPulse(targetPath) {
  const sampleRate = 48_000
  const durationSeconds = 0.16
  const sampleCount = Math.floor(sampleRate * durationSeconds)
  const bytesPerSample = 2
  const dataSize = sampleCount * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28)
  buffer.writeUInt16LE(bytesPerSample, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / sampleCount
    const frequency = 760 - progress * 430
    const envelope = Math.pow(1 - progress, 2.8)
    const value = Math.sin(2 * Math.PI * frequency * (index / sampleRate)) * envelope
    buffer.writeInt16LE(Math.round(value * 20_000), 44 + index * bytesPerSample)
  }
  await fs.writeFile(targetPath, buffer)
}
