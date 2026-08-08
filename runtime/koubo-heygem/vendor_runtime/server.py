from __future__ import print_function

import json
import os
import re
import signal
import subprocess
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


MAX_REQUEST_BYTES = 64 * 1024
CODE_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,160}$")


class JobManager(object):
    def __init__(self):
        self.vendor_root = Path(
            os.environ.get("KOUBO_HEYGEM_VENDOR_ROOT", "/opt/koubo/heygem/vendor")
        ).resolve(strict=True)
        self.runtime_root = Path(
            os.environ.get("KOUBO_RUNTIME_ROOT", "/opt/koubo/runtime")
        ).resolve(strict=True)
        self.python = os.environ.get(
            "KOUBO_HEYGEM_PYTHON", "/opt/koubo/heygem-python/bin/python3.8"
        )
        self.data_root = Path(
            os.environ.get("KOUBO_HEYGEM_DATA_ROOT", "/opt/koubo/heygem-data")
        )
        self.ffmpeg = os.environ.get("KOUBO_FFMPEG", "/usr/bin/ffmpeg")
        self.result_root = self.data_root / "face2face"
        self.temp_root = self.data_root / "temp"
        self.job_root = self.data_root / "jobs"
        self.log_root = self.data_root / "logs"
        for directory in (
            self.result_root,
            self.temp_root,
            self.job_root,
            self.log_root,
        ):
            directory.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._jobs = {}
        self._active_code = None

    def health(self):
        with self._lock:
            active = self._active_code
        return {"status": "busy" if active else "ready", "activeCode": active}

    def submit(self, payload):
        audio = self._input_path(payload.get("audio_url"), "audio_url")
        video = self._input_path(payload.get("video_url"), "video_url")
        code = payload.get("code")
        if not isinstance(code, str) or not CODE_PATTERN.fullmatch(code):
            raise ValueError("code 无效。")
        with self._lock:
            self._refresh_locked()
            if self._active_code is not None:
                raise RuntimeError("HeyGem 当前正在处理另一个任务。")
            result_json = self.job_root / "{}.json".format(code)
            try:
                result_json.unlink()
            except FileNotFoundError:
                pass
            log_path = self.log_root / "{}.log".format(code)
            log_handle = log_path.open("ab", buffering=0)
            command = [
                self.python,
                "-m",
                "vendor_runtime.job",
                "--vendor-root",
                str(self.vendor_root),
                "--audio",
                str(audio),
                "--video",
                str(video),
                "--code",
                code,
                "--result-root",
                str(self.result_root),
                "--temp-root",
                str(self.temp_root / code),
                "--result-json",
                str(result_json),
                "--ffmpeg",
                self.ffmpeg,
            ]
            environment = os.environ.copy()
            environment["PYTHONPATH"] = str(self.runtime_root)
            try:
                process = subprocess.Popen(
                    command,
                    cwd=str(self.vendor_root),
                    env=environment,
                    stdin=subprocess.DEVNULL,
                    stdout=log_handle,
                    stderr=log_handle,
                    shell=False,
                    start_new_session=True,
                    close_fds=True,
                )
            finally:
                log_handle.close()
            self._jobs[code] = {
                "process": process,
                "result_json": result_json,
                "log_path": log_path,
                "cancelled": False,
            }
            self._active_code = code

    def query(self, code):
        with self._lock:
            self._refresh_locked()
            job = self._jobs.get(code)
            if job is None:
                return {"status": "failed", "message": "任务不存在。"}
            process = job["process"]
            if process.poll() is None:
                return {"status": "running"}
            if job["cancelled"]:
                return {"status": "failed", "message": "任务已取消。"}
            payload = self._read_result(job["result_json"])
            if process.returncode != 0 and payload.get("status") != "failed":
                return {
                    "status": "failed",
                    "message": self._last_log(job["log_path"])
                    or "HeyGem 子进程异常退出。",
                }
            return payload

    def cancel(self, code):
        with self._lock:
            job = self._jobs.get(code)
            if job is None:
                return
            process = job["process"]
            job["cancelled"] = True
            if process.poll() is None:
                self._terminate(process)
            if self._active_code == code:
                self._active_code = None

    def stop(self):
        with self._lock:
            for job in self._jobs.values():
                process = job["process"]
                if process.poll() is None:
                    job["cancelled"] = True
                    self._terminate(process)
            self._active_code = None

    def _refresh_locked(self):
        if self._active_code is None:
            return
        job = self._jobs.get(self._active_code)
        if job is None or job["process"].poll() is not None:
            self._active_code = None

    @staticmethod
    def _terminate(process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except OSError:
            return
        try:
            process.wait(timeout=10)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass

    @staticmethod
    def _input_path(raw, field):
        if not isinstance(raw, str) or not raw or "\x00" in raw:
            raise ValueError("{} 无效。".format(field))
        path = Path(raw)
        if not path.is_absolute() or path.is_symlink():
            raise ValueError("{} 必须是普通绝对文件路径。".format(field))
        resolved = path.resolve(strict=True)
        if not resolved.is_file() or resolved.stat().st_size <= 0:
            raise ValueError("{} 文件不存在或为空。".format(field))
        return resolved

    @staticmethod
    def _read_result(path):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"status": "failed", "message": "HeyGem 结果记录缺失或损坏。"}
        if not isinstance(payload, dict):
            return {"status": "failed", "message": "HeyGem 结果记录格式无效。"}
        return payload

    @staticmethod
    def _last_log(path):
        try:
            data = path.read_bytes()
        except OSError:
            return ""
        return data[-2000:].decode("utf-8", errors="replace").strip()


def create_handler(manager):
    class Handler(BaseHTTPRequestHandler):
        server_version = "KouboHeyGemInternal/1"

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._json(HTTPStatus.OK, manager.health())
                return
            if parsed.path == "/easy/query":
                code = parse_qs(parsed.query).get("code", [""])[0]
                result = manager.query(code)
                status_map = {"running": "1", "success": "2", "failed": "3"}
                body = {
                    "code": 0,
                    "data": {
                        "status": status_map.get(result.get("status"), "3"),
                        "result": result.get("result_path"),
                        "message": result.get("message", ""),
                    },
                }
                self._json(HTTPStatus.OK, body)
                return
            self._json(HTTPStatus.NOT_FOUND, {"code": 404, "message": "接口不存在。"})

        def do_POST(self):
            if self.path == "/easy/submit":
                try:
                    manager.submit(self._read_json())
                except (ValueError, OSError) as error:
                    self._json(
                        HTTPStatus.BAD_REQUEST, {"code": 400, "message": str(error)}
                    )
                    return
                except RuntimeError as error:
                    self._json(
                        HTTPStatus.CONFLICT, {"code": 409, "message": str(error)}
                    )
                    return
                self._json(HTTPStatus.OK, {"code": 0, "message": "accepted"})
                return
            if self.path == "/easy/cancel":
                payload = self._read_json()
                code = payload.get("code") if isinstance(payload, dict) else None
                if isinstance(code, str):
                    manager.cancel(code)
                self._json(HTTPStatus.OK, {"code": 0, "message": "cancelled"})
                return
            self._json(HTTPStatus.NOT_FOUND, {"code": 404, "message": "接口不存在。"})

        def _read_json(self):
            try:
                length = int(self.headers.get("content-length") or "")
            except ValueError:
                raise ValueError("Content-Length 无效。")
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("请求体为空或超过 64 KiB。")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("请求体不完整。")
            try:
                payload = json.loads(raw)
            except (UnicodeDecodeError, ValueError):
                raise ValueError("请求体不是有效 JSON。")
            if not isinstance(payload, dict):
                raise ValueError("请求体必须是 JSON 对象。")
            return payload

        def _json(self, status, payload):
            encoded = json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            self.send_response(int(status))
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(encoded)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except BrokenPipeError:
                pass

        def log_message(self, format, *args):
            del format, args

    return Handler


def main():
    manager = JobManager()
    server = ThreadingHTTPServer(("127.0.0.1", 8384), create_handler(manager))

    def stop(signum, frame):
        del signum, frame
        manager.stop()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        manager.stop()
        server.server_close()


if __name__ == "__main__":
    main()

