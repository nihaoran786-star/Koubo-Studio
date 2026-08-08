import argparse
import os
import random
import subprocess
import tempfile
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="IndexTTS2 local inference bridge")
    parser.add_argument("--index-root", required=True)
    parser.add_argument("--reference-audio", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--output-format", default="wav")
    parser.add_argument("--emotion-text", default="")
    parser.add_argument("--emotion-alpha", type=float, default=0.6)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--emotion-reference-audio", default="")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--use-random", type=int, default=0)
    parser.add_argument("--trim-seconds", type=float, default=0)
    return parser.parse_args()


def main():
    args = parse_args()
    index_root = Path(args.index_root).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    os.chdir(index_root)
    if str(index_root) not in os.sys.path:
        os.sys.path.insert(0, str(index_root))

    import numpy as np
    import torch
    from indextts.infer_v2 import IndexTTS2

    if not args.use_random:
        random.seed(args.seed)
        np.random.seed(args.seed)
        torch.manual_seed(args.seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(args.seed)

    needs_filter = output.suffix.lower() != ".wav" or abs(args.speed - 1.0) > 0.001 or args.trim_seconds > 0
    temp_path = None
    inference_output = output
    if needs_filter:
        handle = tempfile.NamedTemporaryFile(prefix="koubo-indextts2-", suffix=".wav", delete=False)
        handle.close()
        temp_path = Path(handle.name)
        inference_output = temp_path

    tts = IndexTTS2(
        cfg_path=str(index_root / "checkpoints" / "config.yaml"),
        model_dir=str(index_root / "checkpoints"),
        use_fp16=torch.cuda.is_available(),
        use_cuda_kernel=False,
        use_deepspeed=False,
    )
    infer_options = {
        "spk_audio_prompt": str(Path(args.reference_audio).resolve()),
        "text": args.text,
        "output_path": str(inference_output),
        "emo_alpha": max(0.0, min(1.0, args.emotion_alpha)),
        "use_random": bool(args.use_random),
        "verbose": True,
    }
    if args.emotion_reference_audio:
        infer_options["emo_audio_prompt"] = str(Path(args.emotion_reference_audio).resolve())
    if args.emotion_text:
        infer_options["use_emo_text"] = True
        infer_options["emo_text"] = args.emotion_text
    tts.infer(**infer_options)

    if needs_filter:
        command = ["ffmpeg", "-y", "-i", str(inference_output)]
        if abs(args.speed - 1.0) > 0.001:
            command.extend(["-filter:a", f"atempo={max(0.5, min(2.0, args.speed)):.4f}"])
        if args.trim_seconds > 0:
            command.extend(["-t", str(args.trim_seconds)])
        command.append(str(output))
        subprocess.run(command, check=True)
        temp_path.unlink(missing_ok=True)

    if not output.is_file() or output.stat().st_size <= 0:
        raise RuntimeError(f"IndexTTS2 did not create a valid output: {output}")


if __name__ == "__main__":
    main()
