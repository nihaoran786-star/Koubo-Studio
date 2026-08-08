import { describe, expect, it } from 'vitest'
import { createDefaultEditPlan, parseEditPlan } from './edit-plan'

describe('EditPlan v1', () => {
  it('creates and parses a safe local editing plan', () => {
    expect(parseEditPlan(createDefaultEditPlan({ ratio: '1:1', subtitleStyle: 'cyan' }))).toMatchObject({
      version: 1,
      ratio: '1:1',
      subtitles: { enabled: true, style: 'cyan', maxCharsPerCue: 18 },
      audio: { voiceVolume: 1 },
      backgroundMusic: { enabled: false },
      export: { format: 'mp4', videoCodec: 'h264' },
    })
  })

  it('rejects unbounded volume and unsupported export commands', () => {
    const plan = createDefaultEditPlan()
    expect(() => parseEditPlan({ ...plan, audio: { voiceVolume: 20 } })).toThrowError(expect.objectContaining({ code: 'invalid_voice_volume' }))
    expect(() => parseEditPlan({ ...plan, export: { format: 'mov', videoCodec: 'copy; rm -rf' } })).toThrowError(expect.objectContaining({ code: 'unsupported_export' }))
  })

  it('does not allow fake optional features without a real asset id', () => {
    const plan = createDefaultEditPlan()
    expect(() => parseEditPlan({ ...plan, backgroundMusic: { enabled: true, volume: 0.2 } })).toThrowError(expect.objectContaining({ code: 'missing_background_music_asset' }))
    expect(() => parseEditPlan({ ...plan, intro: { enabled: true } })).toThrowError(expect.objectContaining({ code: 'missing_optional_asset' }))
  })
})
