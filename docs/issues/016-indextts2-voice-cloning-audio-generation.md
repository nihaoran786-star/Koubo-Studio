# Issue 016 - IndexTTS2 声音克隆与音频生成

## What to build

把根目录 `skills/natural-tts-voice-cloning` 中的 IndexTTS2 工作流包装为音频阶段后端 adapter。它消费 approved script 和 reference audio，先生成短测试音频，再生成完整口播音频，并把结果保存为项目 artifact。

## User pain

数字人流程的第二步需要真实音频，但当前应用没有声音克隆、发音测试、音频产物保存和失败恢复。没有标准 audio artifact，HeyGem 阶段也无法稳定消费音频。

## Acceptance criteria

- [ ] 音频阶段要求已有 approved script。
- [ ] 用户可以选择或上传 reference audio。
- [ ] 后端检查 reference audio 是否存在，并返回明确错误。
- [ ] 支持 8-12 秒短测试音频，用于中文和英文混合发音检查。
- [ ] 支持完整文案音频生成。
- [ ] 输出 WAV 或后续约定格式，并保存到当前项目 workspace。
- [ ] 返回 audio artifact ID、路径、时长、警告和错误信息。
- [ ] 失败状态区分 missing runtime、bad reference audio、path error、synthesis failed。
- [ ] UI 不直接执行 PowerShell、Python、IndexTTS2 命令。

## Blocked by

- Issue 015
- 项目 workspace artifact contract

