param(
  [Parameter(Mandatory = $true)][string]$ReferenceAudio,
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$Output,
  [string]$OutputFormat = "wav",
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [string]$EmotionText = "",
  [double]$EmotionAlpha = 0.6,
  [double]$Speed = 1.0,
  [string]$EmotionReferenceAudio = "",
  [int]$Seed = 0,
  [int]$UseRandom = 0,
  [double]$TrimSeconds = 0
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$indexRoot = Join-Path $RuntimeRoot "IndexTTS"
$python = Join-Path $indexRoot ".venv\Scripts\python.exe"
$driver = Join-Path $PSScriptRoot "natural_tts.py"

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  throw "IndexTTS2 Python runtime not found: $python"
}
if (-not (Test-Path -LiteralPath (Join-Path $indexRoot "checkpoints\config.yaml") -PathType Leaf)) {
  throw "IndexTTS2 checkpoints config not found under: $indexRoot"
}
if (-not (Test-Path -LiteralPath $ReferenceAudio -PathType Leaf)) {
  throw "Reference audio not found: $ReferenceAudio"
}
if (-not (Test-Path -LiteralPath $driver -PathType Leaf)) {
  throw "IndexTTS2 driver not found: $driver"
}

$arguments = @(
  $driver,
  "--index-root", $indexRoot,
  "--reference-audio", $ReferenceAudio,
  "--text", $Text,
  "--output", $Output,
  "--output-format", $OutputFormat,
  "--emotion-alpha", [string]$EmotionAlpha,
  "--speed", [string]$Speed,
  "--seed", [string]$Seed,
  "--use-random", [string]$UseRandom,
  "--trim-seconds", [string]$TrimSeconds
)
if ($EmotionText) { $arguments += @("--emotion-text", $EmotionText) }
if ($EmotionReferenceAudio) { $arguments += @("--emotion-reference-audio", $EmotionReferenceAudio) }

& $python @arguments
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
