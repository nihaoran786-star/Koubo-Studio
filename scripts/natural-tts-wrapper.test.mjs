import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('local IndexTTS2 wrapper', () => {
  it('exposes the adapter contract and delegates to the local Python driver', () => {
    const wrapper = readFileSync(path.join(process.cwd(), 'scripts', 'Invoke-NaturalTTS.ps1'), 'utf8')
    for (const parameter of ['ReferenceAudio', 'Text', 'Output', 'OutputFormat', 'RuntimeRoot', 'EmotionText', 'EmotionAlpha', 'Speed', 'EmotionReferenceAudio', 'Seed', 'UseRandom', 'TrimSeconds']) {
      expect(wrapper).toContain(`$${parameter}`)
    }
    expect(wrapper).toContain('natural_tts.py')
    expect(wrapper).toContain("$env:PYTHONUTF8 = \"1\"")
    expect(wrapper).toContain("$env:PYTHONIOENCODING = \"utf-8\"")
  })
})
