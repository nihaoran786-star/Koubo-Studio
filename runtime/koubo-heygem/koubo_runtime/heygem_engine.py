from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, Sequence

from .protocol import RenderRequest


class EngineError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class EngineReadiness:
    ready: bool
    code: str | None = None
    message: str = ""


@dataclass(frozen=True)
class QueryResult:
    status: str
    result_path: str | None = None
    message: str = ""


class HeyGemClient(Protocol):
    def health(self) -> bool: ...
    def submit(self, *, audio_path: str, video_path: str, code: str, cinema: bool) -> None: ...
    def query(self, code: str) -> QueryResult: ...
    def cancel(self, code: str) -> None: ...


class CommandRunner(Protocol):
    def run(self, argv: Sequence[str], timeout: float) -> subprocess.CompletedProcess[str]: ...


class FixedCommandRunner:
    def run(self, argv: Sequence[str], timeout: float) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            list(argv),
            shell=False,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )


class HttpHeyGemClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8384", timeout: float = 10.0) -> None:
        if base_url != "http://127.0.0.1:8384":
            raise ValueError("internal HeyGem endpoint is fixed")
        self.base_url = base_url
        self.timeout = timeout

    def health(self) -> bool:
        try:
            status, _ = self._request("GET", "/health")
            return 200 <= status < 300
        except EngineError:
            return False

    def submit(self, *, audio_path: str, video_path: str, code: str, cinema: bool) -> None:
        status, payload = self._request("POST", "/easy/submit", {
            "audio_url": audio_path,
            "video_url": video_path,
            "code": code,
            "chaofen": 1 if cinema else 0,
            "watermark_switch": 0,
            "pn": 1,
        })
        if not 200 <= status < 300:
            raise EngineError("task_submit_failed", f"内部 HeyGem submit 返回 HTTP {status}。")
        _raise_payload_error(payload, "task_submit_failed")

    def query(self, code: str) -> QueryResult:
        status, payload = self._request(
            "GET", f"/easy/query?code={urllib.parse.quote(code, safe='')}"
        )
        if not 200 <= status < 300:
            raise EngineError("task_query_failed", f"内部 HeyGem query 返回 HTTP {status}。")
        _raise_payload_error(payload, "task_query_failed")
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        raw_status = data.get("status", payload.get("status"))
        normalized = str(raw_status).lower() if raw_status is not None else ""
        progress = _number(data.get("progress", payload.get("progress")))
        result = _first_string(
            data.get("result"), data.get("result_url"), data.get("video_url"), data.get("url"),
            payload.get("result"), payload.get("result_url"),
        )
        if normalized in {"2", "success", "done"} or (not normalized and progress >= 100):
            return QueryResult("success", result)
        if normalized in {"3", "failed", "error"}:
            return QueryResult("failed", message=_first_string(data.get("msg"), data.get("message")) or "HeyGem 任务失败。")
        return QueryResult("running")

    def cancel(self, code: str) -> None:
        status, payload = self._request("POST", "/easy/cancel", {"code": code})
        if not 200 <= status < 300:
            raise EngineError("task_cancel_failed", f"内部 HeyGem cancel 返回 HTTP {status}。")
        _raise_payload_error(payload, "task_cancel_failed")

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=encoded,
            method=method,
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read(64 * 1024 + 1)
                if len(raw) > 64 * 1024:
                    raise EngineError("internal_response_too_large", "内部 HeyGem 响应超过 64 KiB。")
                payload = json.loads(raw or b"{}")
                return response.status, payload if isinstance(payload, dict) else {}
        except urllib.error.HTTPError as error:
            raw = error.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                raise EngineError("internal_response_too_large", "内部 HeyGem 错误响应超过 64 KiB。") from error
            try:
                payload = json.loads(raw or b"{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = {"message": raw.decode("utf-8", errors="replace")}
            return error.code, payload if isinstance(payload, dict) else {}
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise EngineError("internal_runtime_unavailable", f"内部 HeyGem 服务不可用：{error}") from error


class HeyGemEngine:
    DEFAULT_VENDOR_ROOT = Path("/opt/koubo/heygem/vendor")
    DEFAULT_RESULT_ROOT = Path("/opt/koubo/heygem-data/face2face")
    FFPROBE = "/usr/bin/ffprobe"
    SUPERVISOR = "/opt/koubo/heygem/vendor/bin/heygem-supervisor"

    def __init__(
        self,
        client: HeyGemClient | None = None,
        runner: CommandRunner | None = None,
        vendor_root: Path | None = None,
        result_root: Path | None = None,
        timeout_seconds: float = 30 * 60,
        poll_interval_seconds: float = 1.0,
        recovery_attempts: int = 30,
        recovery_interval_seconds: float = 1.0,
    ) -> None:
        self.client = client or HttpHeyGemClient()
        self.runner = runner or FixedCommandRunner()
        self.vendor_root = vendor_root or self.DEFAULT_VENDOR_ROOT
        self.result_root = result_root or self.DEFAULT_RESULT_ROOT
        self.timeout_seconds = timeout_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self.recovery_attempts = recovery_attempts
        self.recovery_interval_seconds = recovery_interval_seconds
        self._cancel = threading.Event()
        self._active_lock = threading.Lock()
        self._active_code: str | None = None

    def inspect(self) -> EngineReadiness:
        try:
            self._validate_vendor_assets()
        except EngineError as error:
            return EngineReadiness(False, error.code, error.message)
        if not self.client.health():
            return EngineReadiness(False, "internal_runtime_unavailable", "内部 HeyGem 服务尚未就绪。")
        return EngineReadiness(True)

    def cancel_active(self) -> None:
        self._cancel.set()

    def render(self, request: RenderRequest) -> None:
        readiness = self.inspect()
        if not readiness.ready:
            raise EngineError(readiness.code or "runtime_not_ready", readiness.message)
        self._cancel.clear()
        code = f"{request.project_id}-{uuid.uuid4().hex}"
        with self._active_lock:
            self._active_code = code
        try:
            try:
                self.client.submit(
                    audio_path=str(request.audio_path),
                    video_path=str(request.avatar_path),
                    code=code,
                    cinema=request.mode == "cinema",
                )
            except EngineError as error:
                if error.code == "internal_runtime_unavailable":
                    self._ensure_terminated(code)
                raise
            deadline = time.monotonic() + self.timeout_seconds
            while time.monotonic() <= deadline:
                if self._cancel.is_set():
                    self._ensure_terminated(code)
                    raise EngineError("task_cancelled", "数字人生成已取消。")
                try:
                    result = self.client.query(code)
                except EngineError as error:
                    # Once submit has returned successfully, every query error leaves
                    # task termination uncertain. The current internal protocol has no
                    # separate proof that a failed query also stopped its worker.
                    self._ensure_terminated(code)
                    raise
                if result.status == "failed":
                    raise EngineError("task_failed", result.message or "HeyGem 任务失败。")
                if result.status == "success":
                    if not result.result_path:
                        raise EngineError("output_missing", "HeyGem 任务完成但没有返回结果路径。")
                    source = self._trusted_result_path(result.result_path)
                    self._validate_video(source)
                    self._copy_result(source, request.output_path)
                    return
                if self.poll_interval_seconds > 0:
                    self._cancel.wait(self.poll_interval_seconds)
            self._ensure_terminated(code)
            raise EngineError("task_timeout", "HeyGem 任务轮询超时。")
        finally:
            with self._active_lock:
                if self._active_code == code:
                    self._active_code = None

    def _ensure_terminated(self, code: str) -> None:
        try:
            self.client.cancel(code)
            return
        except Exception:
            pass

        try:
            result = self.runner.run((self.SUPERVISOR, "reset-worker"), 120.0)
        except (OSError, subprocess.TimeoutExpired):
            raise EngineError(
                "runtime_recovery_failed",
                "无法确认 HeyGem 任务已终止，内部 worker 重置失败。",
            ) from None
        if result.returncode != 0:
            raise EngineError(
                "runtime_recovery_failed",
                "无法确认 HeyGem 任务已终止，内部 worker 重置失败。",
            )
        for attempt in range(max(1, self.recovery_attempts)):
            if self.client.health():
                return
            if attempt + 1 < self.recovery_attempts and self.recovery_interval_seconds > 0:
                time.sleep(self.recovery_interval_seconds)
        raise EngineError(
            "runtime_recovery_failed",
            "HeyGem worker 已重置，但内部服务未恢复健康。",
        )

    def _validate_vendor_assets(self) -> None:
        manifest_path = self.vendor_root / "vendor-manifest.json"
        try:
            if manifest_path.is_symlink():
                raise OSError("manifest is symlink")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise EngineError("vendor_assets_missing", "HeyGem vendor 资产清单缺失或无效。") from None
        files = manifest.get("files") if isinstance(manifest, dict) else None
        if manifest.get("schemaVersion") != 1 or manifest.get("engine") != "HeyGem" or not isinstance(files, list) or not files:
            raise EngineError("vendor_manifest_invalid", "HeyGem vendor 资产清单格式无效。")
        kinds: set[str] = set()
        canonical_root = self.vendor_root.resolve(strict=True)
        for entry in files:
            if not isinstance(entry, dict) or entry.get("kind") not in {"runtime", "model", "binary"}:
                raise EngineError("vendor_manifest_invalid", "HeyGem vendor 资产条目格式无效。")
            relative = entry.get("path")
            if not isinstance(relative, str) or not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
                raise EngineError("vendor_manifest_invalid", "HeyGem vendor 资产路径无效。")
            candidate = self.vendor_root / relative
            try:
                if candidate.is_symlink():
                    raise OSError("asset is symlink")
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(canonical_root)
                if not resolved.is_file() or resolved.stat().st_size <= 0:
                    raise OSError("asset is empty")
            except (OSError, ValueError):
                raise EngineError("vendor_assets_missing", f"HeyGem vendor 资产缺失：{relative}") from None
            kinds.add(entry["kind"])
        if not {"runtime", "model"}.issubset(kinds):
            raise EngineError("vendor_manifest_invalid", "HeyGem vendor 清单必须同时声明 runtime 与 model 资产。")

    def _trusted_result_path(self, raw: str) -> Path:
        if "\x00" in raw:
            raise EngineError("result_path_invalid", "HeyGem 返回的结果路径无效。")
        candidate = Path(raw)
        if not candidate.is_absolute() or candidate.is_symlink():
            raise EngineError("result_path_invalid", "HeyGem 必须返回可信结果根目录内的绝对路径。")
        try:
            root = self.result_root.resolve(strict=True)
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(root)
        except (OSError, ValueError):
            raise EngineError("result_path_escape", "HeyGem 返回的结果路径越过可信结果目录。") from None
        if not resolved.is_file() or resolved.stat().st_size <= 0:
            raise EngineError("output_missing", "HeyGem 没有生成有效视频文件。")
        return resolved

    def _validate_video(self, source: Path) -> None:
        argv = (
            self.FFPROBE, "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_type", "-of", "default=nw=1:nk=1", str(source),
        )
        try:
            result = self.runner.run(argv, 30.0)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise EngineError("result_probe_failed", f"无法验证 HeyGem 视频：{error}") from error
        if result.returncode != 0 or "video" not in result.stdout.lower():
            raise EngineError("result_invalid", "HeyGem 结果无法通过 ffprobe 视频流验证。")

    def _copy_result(self, source: Path, output: Path) -> None:
        temp = output.parent / f".{output.name}.{uuid.uuid4().hex}.tmp"
        try:
            with source.open("rb") as reader, temp.open("xb") as writer:
                shutil.copyfileobj(reader, writer, length=1024 * 1024)
                writer.flush()
                os.fsync(writer.fileno())
            os.replace(temp, output)
        except OSError as error:
            raise EngineError("result_copy_failed", f"无法复制 HeyGem 结果：{error}") from error
        finally:
            temp.unlink(missing_ok=True)


def _raise_payload_error(payload: dict[str, Any], fallback: str) -> None:
    code = payload.get("code")
    if code is not None and str(code) not in {"0", "10000"}:
        raise EngineError(fallback, _first_string(payload.get("msg"), payload.get("message")) or f"HeyGem 错误码：{code}")


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return -1


def _first_string(*values: Any) -> str | None:
    return next((value.strip() for value in values if isinstance(value, str) and value.strip()), None)
