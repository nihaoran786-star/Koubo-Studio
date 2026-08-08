import { Composition, registerRoot } from 'remotion'
import { KouboAutoEdit, type KouboAutoEditProps } from './koubo-auto-edit'

const defaultProps: KouboAutoEditProps = {
  durationSeconds: 5,
  scriptText: '让 AI 把口播剪得更有节奏。',
  subtitleStyle: 'bold',
  maxCharsPerCue: 14,
  creative: {
    preset: 'energetic',
    motion: 'punch',
    captions: 'impact',
    colorGrade: 'vivid',
    soundEffects: 'subtle',
    hook: '这次真的开始精剪',
    emphasis: ['AI', '更有节奏'],
    effects: ['animated-captions', 'hook-card', 'punch-zoom', 'progress-line', 'light-leak'],
  },
}

const Root = () => (
  <Composition
    id="KouboAutoEdit"
    component={KouboAutoEdit}
    width={720}
    height={1280}
    fps={30}
    durationInFrames={150}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, Math.ceil(props.durationSeconds * 30)),
      width: 720,
      height: 1280,
      fps: 30,
    })}
  />
)

registerRoot(Root)
