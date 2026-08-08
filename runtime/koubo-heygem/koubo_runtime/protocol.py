from __future__ import annotations

import os
import posixpath
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class RenderRequest:
    project_id: str
    audio_path: Path
    avatar_path: Path
    output_path: Path
    output_path_raw: str
    mode: str


_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_WSL_MOUNT = re.compile(r"^/mnt/([a-z])(?:/[^/]+)+$")
_AUDIO_SUFFIXES = {".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"}
_AVATAR_SUFFIXES = {".avi", ".mkv", ".mov", ".mp4", ".webm"}
_MODES = {"fast", "standard", "cinema"}


def parse_render_request(payload: Any) -> RenderRequest:
    if not isinstance(payload, dict):
        raise ProtocolError("invalid_request", "请求体必须是 JSON 对象。")
    if payload.get("pathDialect") != "wsl_mount_v1":
        raise ProtocolError("path_dialect_invalid", "KouboRuntime 只接受 wsl_mount_v1 路径。")

    project_id = _required_string(payload, "projectId", 128)
    if not _SAFE_ID.fullmatch(project_id):
        raise ProtocolError("project_id_invalid", "projectId 格式无效。")
    mode = _required_string(payload, "mode", 16)
    if mode not in _MODES:
        raise ProtocolError("mode_invalid", "mode 必须是 fast、standard 或 cinema。")

    avatar = payload.get("avatar")
    if not isinstance(avatar, dict) or avatar.get("source") != "upload":
        raise ProtocolError("avatar_source_unsupported", "本地运行环境只接受已导入的视频形象素材。")

    audio_raw = _required_string(payload, "audioPath", 4096)
    avatar_raw = _required_string(avatar, "assetPath", 4096)
    output_raw = _required_string(payload, "outputPath", 4096)
    return RenderRequest(
        project_id=project_id,
        audio_path=_existing_input_path(audio_raw, "audio", _AUDIO_SUFFIXES),
        avatar_path=_existing_input_path(avatar_raw, "avatar", _AVATAR_SUFFIXES),
        output_path=_new_output_path(output_raw),
        output_path_raw=output_raw,
        mode=mode,
    )


def _required_string(value: dict[str, Any], key: str, limit: int) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str) or not candidate or len(candidate) > limit or "\x00" in candidate:
        raise ProtocolError("invalid_request", f"{key} 缺失或格式无效。")
    return candidate


def _mount_path(raw: str, field: str) -> tuple[Path, Path]:
    if "\\" in raw or ":" in raw or posixpath.normpath(raw) != raw:
        raise ProtocolError("path_invalid", f"{field} 不是规范的 WSL 挂载路径。")
    match = _WSL_MOUNT.fullmatch(raw)
    if not match:
        raise ProtocolError("path_invalid", f"{field} 必须位于 /mnt/<盘符>/...。")
    segments = raw.split("/")[3:]
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ProtocolError("path_invalid", f"{field} 包含无效路径段。")
    return Path(raw), Path("/mnt") / match.group(1)


def _existing_input_path(raw: str, field: str, suffixes: set[str]) -> Path:
    candidate, mount_root = _mount_path(raw, field)
    if candidate.is_symlink():
        raise ProtocolError("path_invalid", f"{field} 不允许使用符号链接。")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(mount_root.resolve(strict=True))
    except (OSError, ValueError):
        raise ProtocolError("path_invalid", f"{field} 不存在或越过 Windows 挂载盘。") from None
    if not resolved.is_file() or resolved.suffix.lower() not in suffixes:
        raise ProtocolError("media_invalid", f"{field} 不是支持的普通媒体文件。")
    return resolved


def _new_output_path(raw: str) -> Path:
    candidate, mount_root = _mount_path(raw, "output")
    if candidate.suffix.lower() != ".mp4":
        raise ProtocolError("output_invalid", "output 必须是新的 MP4 候选路径。")
    if candidate.exists() or candidate.is_symlink():
        raise ProtocolError("output_exists", "output 候选文件已经存在。")
    try:
        parent = candidate.parent.resolve(strict=True)
        parent.relative_to(mount_root.resolve(strict=True))
    except (OSError, ValueError):
        raise ProtocolError("path_invalid", "output 父目录不存在或越过 Windows 挂载盘。") from None
    if not parent.is_dir() or not os.access(parent, os.W_OK):
        raise ProtocolError("output_unwritable", "output 父目录不可写。")
    return parent / candidate.name
