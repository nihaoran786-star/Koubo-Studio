import { LightLeak } from '@remotion/light-leaks'
import { Audio, Video } from '@remotion/media'
import { AnimatedText } from 'remotion-bits'
import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion'

export interface KouboAutoEditProps extends Record<string, unknown> {
  durationSeconds: number
  scriptText: string
  subtitleStyle: 'clean' | 'bold' | 'cyan'
  maxCharsPerCue: number
  creative: {
    preset: 'clean' | 'energetic' | 'cinematic'
    motion: 'none' | 'punch' | 'dynamic'
    captions: 'static' | 'karaoke' | 'impact'
    colorGrade: 'natural' | 'vivid' | 'warm'
    soundEffects: 'off' | 'subtle' | 'punch'
    hook?: string
    emphasis: string[]
    effects: string[]
  }
}

export const KouboAutoEdit = ({
  durationSeconds,
  scriptText,
  subtitleStyle,
  maxCharsPerCue,
  creative,
}: KouboAutoEditProps) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const effects = new Set(creative.effects)
  const beatFrames = Math.max(36, Math.round(fps * (creative.motion === 'dynamic' ? 1.35 : 1.8)))
  const beatFrame = frame % beatFrames
  const punch = creative.motion === 'none'
    ? 1
    : interpolate(
        beatFrame,
        [0, Math.min(6, beatFrames / 4), beatFrames - 1],
        [creative.motion === 'dynamic' ? 1.075 : 1.045, 1.025, 1],
        {
          easing: Easing.bezier(0.16, 1, 0.3, 1),
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        },
      )
  const filter = creative.colorGrade === 'vivid'
    ? 'contrast(1.07) saturate(1.14) brightness(1.02)'
    : creative.colorGrade === 'warm'
      ? 'sepia(0.08) saturate(1.08) contrast(1.04)'
      : 'contrast(1.025) saturate(1.04)'
  const cues = createCaptionCues(scriptText, maxCharsPerCue, durationSeconds)

  return (
    <AbsoluteFill style={{ backgroundColor: '#05070b', overflow: 'hidden' }}>
      <Video
        src={staticFile('input.mp4')}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          scale: punch,
          filter,
        }}
      />
      <AbsoluteFill
        style={{
          background:
            creative.preset === 'cinematic'
              ? 'linear-gradient(180deg, rgba(2,6,12,.42), transparent 28%, transparent 66%, rgba(2,6,12,.62))'
              : 'linear-gradient(180deg, rgba(2,6,12,.2), transparent 30%, transparent 70%, rgba(2,6,12,.48))',
          boxShadow: 'inset 0 0 120px rgba(0,0,0,.34)',
        }}
      />

      {effects.has('focus-glow') ? (
        <AbsoluteFill
          style={{
            background: 'radial-gradient(circle at 50% 45%, rgba(34,211,238,.14), transparent 42%)',
            mixBlendMode: 'screen',
            opacity: interpolate(beatFrame, [0, 8, beatFrames - 1], [0.55, 0.08, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        />
      ) : null}

      {effects.has('hook-card') && creative.hook ? (
        <Sequence from={0} durationInFrames={Math.min(durationInFrames, Math.round(fps * 1.65))}>
          <HookCard text={creative.hook} />
        </Sequence>
      ) : null}

      {cues.map((cue, index) => (
        <Sequence
          key={`${cue.text}-${index}`}
          from={cue.fromFrame}
          durationInFrames={Math.max(1, cue.toFrame - cue.fromFrame)}
        >
          <CaptionCard
            text={cue.text}
            styleName={subtitleStyle}
            mode={creative.captions}
            emphasis={creative.emphasis}
          />
        </Sequence>
      ))}

      {effects.has('light-leak') ? (
        <>
          <Sequence from={Math.min(durationInFrames - 1, Math.round(fps * 0.8))} durationInFrames={Math.min(14, durationInFrames)}>
            <LightLeak seed={7} hueShift={12} style={{ opacity: 0.42 }} />
          </Sequence>
          {durationInFrames > fps * 3 ? (
            <Sequence from={Math.round(durationInFrames * 0.56)} durationInFrames={Math.min(12, durationInFrames)}>
              <LightLeak seed={19} hueShift={325} style={{ opacity: 0.3 }} />
            </Sequence>
          ) : null}
        </>
      ) : null}

      {effects.has('film-burn') ? <FilmBurnOverlay /> : null}
      {effects.has('progress-line') ? <ProgressLine /> : null}
      {creative.soundEffects !== 'off' ? (
        <BeatSoundEffects intensity={creative.soundEffects} />
      ) : null}
    </AbsoluteFill>
  )
}

const HookCard = ({ text }: { text: string }) => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: 120, pointerEvents: 'none' }}>
      <div
        style={{
          opacity: interpolate(frame, [0, 6, 38, 49], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          translate: `0 ${interpolate(frame, [0, 10], [-28, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px`,
          maxWidth: 580,
          padding: '18px 26px',
          borderRadius: 24,
          background: 'linear-gradient(135deg, rgba(4,10,18,.88), rgba(8,25,34,.76))',
          border: '1px solid rgba(103,232,249,.38)',
          boxShadow: '0 18px 60px rgba(0,0,0,.34), inset 0 1px rgba(255,255,255,.12)',
          color: 'white',
          fontFamily: '"Microsoft YaHei", sans-serif',
          fontSize: 42,
          lineHeight: 1.24,
          fontWeight: 800,
          textAlign: 'center',
          letterSpacing: 1,
        }}
      >
        <AnimatedText
          transition={{
            y: [24, 0],
            opacity: [0, 1],
            frames: [0, 10],
            split: 'word',
            splitStagger: 1.5,
          }}
        >
          {text}
        </AnimatedText>
      </div>
    </AbsoluteFill>
  )
}

const CaptionCard = ({
  text,
  styleName,
  mode,
  emphasis,
}: {
  text: string
  styleName: KouboAutoEditProps['subtitleStyle']
  mode: KouboAutoEditProps['creative']['captions']
  emphasis: string[]
}) => {
  const frame = useCurrentFrame()
  const accent = styleName === 'cyan' ? '#67e8f9' : '#fde047'
  const parts = splitEmphasis(text, emphasis)
  const enter = interpolate(frame, [0, mode === 'impact' ? 7 : 5], [0, 1], {
    easing: Easing.bezier(0.34, 1.32, 0.64, 1),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 72px 150px' }}>
      <div
        style={{
          maxWidth: 620,
          padding: mode === 'impact' ? '15px 24px 18px' : '12px 20px 15px',
          borderRadius: 18,
          background: styleName === 'clean' ? 'rgba(255,255,255,.9)' : 'rgba(3,7,14,.78)',
          border: styleName === 'cyan' ? '1px solid rgba(103,232,249,.5)' : '1px solid rgba(255,255,255,.16)',
          boxShadow: '0 12px 48px rgba(0,0,0,.38)',
          color: styleName === 'clean' ? '#0b1118' : '#fff',
          fontFamily: '"Microsoft YaHei", sans-serif',
          fontSize: mode === 'impact' ? 48 : 42,
          lineHeight: 1.3,
          fontWeight: 900,
          textAlign: 'center',
          letterSpacing: 1,
          opacity: enter,
          scale: mode === 'static' ? 1 : 0.9 + enter * 0.1,
          translate: `0 ${14 - enter * 14}px`,
        }}
      >
        {parts.map((part, index) => (
          <span
            key={`${part.text}-${index}`}
            style={{
              color: part.emphasis ? accent : undefined,
              textShadow: part.emphasis ? `0 0 18px ${accent}88` : '0 2px 8px rgba(0,0,0,.45)',
            }}
          >
            {part.text}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  )
}

const ProgressLine = () => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        bottom: 0,
        height: 8,
        width: `${Math.min(100, ((frame + 1) / durationInFrames) * 100)}%`,
        background: 'linear-gradient(90deg, #22d3ee, #facc15)',
        boxShadow: '0 0 22px rgba(34,211,238,.7)',
      }}
    />
  )
}

const FilmBurnOverlay = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const cycle = frame % Math.max(1, Math.round(fps * 2.8))
  const opacity = interpolate(cycle, [0, 2, 8, 13], [0, 0.62, 0.2, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  return (
    <AbsoluteFill
      style={{
        opacity,
        mixBlendMode: 'screen',
        background:
          'radial-gradient(circle at 15% 65%, rgba(255,243,170,.95), rgba(255,98,0,.72) 24%, transparent 58%)',
      }}
    />
  )
}

const BeatSoundEffects = ({
  intensity,
}: {
  intensity: 'subtle' | 'punch'
}) => {
  const { durationInFrames, fps } = useVideoConfig()
  const interval = Math.max(42, Math.round(fps * (intensity === 'punch' ? 1.7 : 2.2)))
  const starts: number[] = []
  for (let frame = Math.round(fps * 0.75); frame < durationInFrames; frame += interval) {
    starts.push(frame)
  }
  return (
    <>
      {starts.map((from) => (
        <Sequence key={from} from={from} durationInFrames={Math.min(8, durationInFrames - from)}>
          <Audio
            src={staticFile('edit-pulse.wav')}
            volume={intensity === 'punch' ? 0.18 : 0.08}
          />
        </Sequence>
      ))}
    </>
  )
}

function createCaptionCues(text: string, maxChars: number, durationSeconds: number) {
  const normalized = text.replace(/\s+/g, '').trim() || '口播成片'
  const phrases = normalized.split(/(?<=[，。！？；,.!?;])/u).filter(Boolean)
  const chunks: string[] = []
  for (const phrase of phrases.length ? phrases : [normalized]) {
    for (let index = 0; index < phrase.length; index += maxChars) {
      chunks.push(phrase.slice(index, index + maxChars))
    }
  }
  const totalChars = chunks.reduce((sum, value) => sum + value.length, 0)
  let cursor = 0
  return chunks.map((value, index) => {
    const from = cursor
    cursor += index === chunks.length - 1 ? durationSeconds - cursor : durationSeconds * (value.length / totalChars)
    return {
      text: value,
      fromFrame: Math.round(from * 30),
      toFrame: Math.max(Math.round(from * 30) + 1, Math.round(cursor * 30)),
    }
  })
}

function splitEmphasis(text: string, emphasis: string[]) {
  const keywords = [...emphasis].filter(Boolean).sort((a, b) => b.length - a.length)
  if (!keywords.length) return [{ text, emphasis: false }]
  const escaped = keywords.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gu')
  return text.split(pattern).filter(Boolean).map((value) => ({
    text: value,
    emphasis: keywords.includes(value),
  }))
}
