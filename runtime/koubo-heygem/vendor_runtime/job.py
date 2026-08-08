from __future__ import print_function

import argparse
import json
import os
import queue
import subprocess
import sys
import time
import uuid
from pathlib import Path


def _bootstrap_spawn_imports():
    vendor_root = os.environ.get("KOUBO_HEYGEM_VENDOR_ROOT")
    if not vendor_root:
        return
    if vendor_root not in sys.path:
        sys.path.insert(0, vendor_root)
    import service.trans_dh_service as service_module

    # Some vendor Cython types identify their module as ``trans_dh_service``
    # even though the extension must be imported as part of ``service`` for
    # its relative imports to work.
    sys.modules.setdefault("trans_dh_service", service_module)


_bootstrap_spawn_imports()


def _write_json_atomic(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(".{}.{}.tmp".format(path.name, uuid.uuid4().hex))
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temporary), str(path))
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def write_video(
    output_imgs_queue,
    temp_dir,
    result_dir,
    work_id,
    audio_path,
    result_queue,
    width,
    height,
    fps,
    watermark_switch=0,
    digital_auth=0,
    temp_queue=None,
):
    import cv2

    del watermark_switch, digital_auth, temp_queue
    temp_root = Path(temp_dir)
    result_root = Path(result_dir)
    temp_root.mkdir(parents=True, exist_ok=True)
    result_root.mkdir(parents=True, exist_ok=True)
    silent_path = temp_root / "{}-silent.mp4".format(work_id)
    result_path = result_root / "{}-r.mp4".format(work_id)
    writer = cv2.VideoWriter(
        str(silent_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        float(fps),
        (int(width), int(height)),
    )
    if not writer.isOpened():
        result_queue.put([False, "无法创建 HeyGem 中间视频。"])
        return
    try:
        while True:
            state, reason, frames = output_imgs_queue.get()
            if state is True:
                break
            if state is False:
                raise RuntimeError(str(reason or "HeyGem 帧生成失败。"))
            for frame in frames:
                writer.write(frame)
    except Exception as error:
        result_queue.put([False, str(error)])
        return
    finally:
        writer.release()

    command = [
        os.environ.get("KOUBO_HEYGEM_FFMPEG", "/usr/bin/ffmpeg"),
        "-loglevel",
        "warning",
        "-y",
        "-i",
        str(silent_path),
        "-i",
        str(audio_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        str(result_path),
    ]
    completed = subprocess.run(
        command,
        shell=False,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        timeout=300,
    )
    if completed.returncode != 0:
        result_queue.put(
            [False, "FFmpeg 合并音视频失败：{}".format(completed.stderr[-1000:])]
        )
        return
    result_queue.put([True, str(result_path.resolve())])


def _install_video_writer(service, ffmpeg):
    os.environ["KOUBO_HEYGEM_FFMPEG"] = ffmpeg
    service.write_video = write_video


def _finalize_result(temp_root, result_root, code):
    filename = "{}-r.mp4".format(code)
    destination = result_root / filename
    candidates = (destination, temp_root / filename)
    source = next(
        (
            candidate
            for candidate in candidates
            if candidate.is_file() and candidate.stat().st_size > 0
        ),
        None,
    )
    if source is None:
        raise RuntimeError("HeyGem 返回的视频不存在或为空。")
    if source != destination:
        os.replace(str(source), str(destination))
    return destination.resolve(strict=True)


def _parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vendor-root", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--code", required=True)
    parser.add_argument("--result-root", required=True)
    parser.add_argument("--temp-root", required=True)
    parser.add_argument("--result-json", required=True)
    parser.add_argument("--ffmpeg", default="/usr/bin/ffmpeg")
    return parser.parse_args()


def main():
    args = _parse_args()
    vendor_root = Path(args.vendor_root).resolve(strict=True)
    audio_path = Path(args.audio).resolve(strict=True)
    video_path = Path(args.video).resolve(strict=True)
    result_root = Path(args.result_root)
    temp_root = Path(args.temp_root)
    result_json = Path(args.result_json)
    result_root.mkdir(parents=True, exist_ok=True)
    temp_root.mkdir(parents=True, exist_ok=True)
    os.environ["KOUBO_HEYGEM_VENDOR_ROOT"] = str(vendor_root)
    os.chdir(str(vendor_root))
    sys.path.insert(0, str(vendor_root))

    try:
        import service.trans_dh_service as trans_dh_service
        from y_utils.config import GlobalConfig

        sys.modules.setdefault("trans_dh_service", trans_dh_service)

        config = GlobalConfig.instance()
        config.result_dir = str(result_root)
        config.temp_dir = str(temp_root)
        _install_video_writer(trans_dh_service, args.ffmpeg)

        # Match the vendor runner: spawned workers must not inherit this
        # wrapper's CLI flags, which the compiled runtime does not understand.
        sys.argv = [sys.argv[0]]
        task = trans_dh_service.TransDhTask()
        # The vendor initializes multiprocessing workers asynchronously.
        # Its own reference runner waits ten seconds before the first work()
        # call; without this warm-up the preprocessing command is silently
        # dropped and the expected formatted video never appears.
        time.sleep(10)
        task.task_dic[args.code] = ""
        task.work(
            str(audio_path),
            str(video_path),
            args.code,
            0,
            0,
            0,
            0,
        )
        task_result = task.task_dic.get(args.code)
        if not isinstance(task_result, (list, tuple)) or len(task_result) < 3:
            raise RuntimeError("HeyGem 未返回有效任务结果。")
        result_path = _finalize_result(temp_root, result_root, args.code)
        _write_json_atomic(
            result_json,
            {"status": "success", "result_path": str(result_path)},
        )
        return 0
    except BaseException as error:
        _write_json_atomic(
            result_json,
            {"status": "failed", "message": str(error) or error.__class__.__name__},
        )
        raise


if __name__ == "__main__":
    raise SystemExit(main())
