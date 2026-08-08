from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

EXPECTED_COMMIT = "26a11ef830d5969957081dfc30f6f779d0b43fcb"
EXPECTED_ARCHIVE_ROOT = f"HeyGem-Linux-Python-Hack-{EXPECTED_COMMIT}/"
EXPECTED_MODEL_COUNT = 9
EXPECTED_FILE_COUNT = 10
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class ValidationError(ValueError):
    pass


def validate_build_cache(lock_path: Path, cache_root: Path) -> None:
    lock = _read_lock(lock_path)
    entries = _validate_lock(lock)
    expected_paths = {entry["cachePath"] for entry in entries}
    actual_paths = {
        file.relative_to(cache_root).as_posix()
        for file in cache_root.rglob("*")
        if file.is_file()
    } if cache_root.is_dir() else set()

    partials = sorted(path for path in actual_paths if path.lower().endswith(".part"))
    if partials:
        raise ValidationError(f"缓存包含未完成的 .part 文件：{partials[0]}")
    missing = sorted(expected_paths - actual_paths)
    if missing:
        raise ValidationError(f"缓存缺少锁定文件：{missing[0]}")
    extra = sorted(actual_paths - expected_paths)
    if extra:
        raise ValidationError(f"缓存包含锁外文件：{extra[0]}")

    total = 0
    for entry in entries:
        file_path = _inside_cache(cache_root, entry["cachePath"])
        stat = file_path.stat()
        if not file_path.is_file() or file_path.is_symlink():
            raise ValidationError(f"缓存项不是普通文件：{entry['cachePath']}")
        if stat.st_size != entry["size"]:
            raise ValidationError(f"缓存项大小不匹配：{entry['cachePath']}")
        if _sha256(file_path) != entry["sha256"]:
            raise ValidationError(f"缓存项 SHA-256 不匹配：{entry['cachePath']}")
        total += stat.st_size
    if total != lock["expectedTotalBytes"]:
        raise ValidationError("缓存总字节数与锁定值不匹配。")

    source = lock["sourceArchive"]
    _validate_source_archive(
        _inside_cache(cache_root, source["cachePath"]),
        source["archiveRoot"],
        source["overlayExcludes"],
    )


def overlay_members(
    members: Iterable[tarfile.TarInfo],
    archive_root: str,
    excludes: list[str],
) -> list[str]:
    selected: list[str] = []
    for member in members:
        relative = _archive_relative_path(member.name, archive_root)
        if relative is None or not relative:
            continue
        if any(_matches_exclude(relative, exclude) for exclude in excludes):
            continue
        selected.append(relative)
    return selected


def _read_lock(lock_path: Path) -> dict[str, Any]:
    try:
        value = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"无法读取 sources lock：{error}") from error
    if not isinstance(value, dict):
        raise ValidationError("sources lock 必须是 JSON 对象。")
    return value


def _validate_lock(lock: dict[str, Any]) -> list[dict[str, Any]]:
    if lock.get("schemaVersion") != 1:
        raise ValidationError("sources lock schemaVersion 必须为 1。")
    if lock.get("engine") != "HeyGem":
        raise ValidationError("sources lock engine 必须为 HeyGem。")
    if lock.get("usage") != "local_validation_only":
        raise ValidationError("sources lock usage 必须为 local_validation_only。")
    distribution = lock.get("distribution")
    if not isinstance(distribution, dict) or distribution.get("redistributionAuthorized") is not False:
        raise ValidationError("sources lock 必须明确禁止再分发。")

    upstream = lock.get("upstream")
    source = lock.get("sourceArchive")
    models = lock.get("models")
    if not isinstance(upstream, dict) or upstream.get("commit") != EXPECTED_COMMIT:
        raise ValidationError("上游 commit 与固定值不一致。")
    if not isinstance(source, dict) or source.get("archiveRoot") != EXPECTED_ARCHIVE_ROOT:
        raise ValidationError("源码归档根与固定 commit 不一致。")
    if not isinstance(models, list) or len(models) != EXPECTED_MODEL_COUNT:
        raise ValidationError(f"models 必须恰好包含 {EXPECTED_MODEL_COUNT} 项。")
    if lock.get("expectedCacheFileCount") != EXPECTED_FILE_COUNT:
        raise ValidationError(f"expectedCacheFileCount 必须为 {EXPECTED_FILE_COUNT}。")

    excludes = source.get("overlayExcludes")
    if not isinstance(excludes, list) or not excludes:
        raise ValidationError("overlayExcludes 不能为空。")
    if len(excludes) != len(set(excludes)):
        raise ValidationError("overlayExcludes 不允许重复。")
    for exclude in excludes:
        _safe_relative_path(exclude.rstrip("/"), "overlayExcludes")

    entries = [source, *models]
    if len(entries) != EXPECTED_FILE_COUNT:
        raise ValidationError(f"锁定文件必须恰好为 {EXPECTED_FILE_COUNT} 个。")
    cache_paths: set[str] = set()
    target_paths: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValidationError("锁定文件条目格式无效。")
        cache_path = entry.get("cachePath")
        _safe_relative_path(cache_path, "cachePath")
        if cache_path in cache_paths:
            raise ValidationError(f"cachePath 重复：{cache_path}")
        cache_paths.add(cache_path)
        size = entry.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise ValidationError(f"size 无效：{cache_path}")
        digest = entry.get("sha256")
        if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
            raise ValidationError(f"sha256 无效：{cache_path}")
        if index > 0:
            target_path = entry.get("targetPath")
            _safe_relative_path(target_path, "targetPath")
            if target_path in target_paths:
                raise ValidationError(f"targetPath 重复：{target_path}")
            target_paths.add(target_path)

    expected_total = lock.get("expectedTotalBytes")
    locked_total = sum(entry["size"] for entry in entries)
    if not isinstance(expected_total, int) or expected_total != locked_total:
        raise ValidationError("expectedTotalBytes 与各文件 size 之和不一致。")

    forbidden = lock.get("forbiddenDownloads")
    if not isinstance(forbidden, list) or not all(isinstance(item, str) and item for item in forbidden):
        raise ValidationError("forbiddenDownloads 格式无效。")
    for cache_path in cache_paths:
        cache_name = PurePosixPath(cache_path).name.casefold()
        for item in forbidden:
            if item.casefold() in cache_name:
                raise ValidationError(f"缓存名命中 forbiddenDownloads：{cache_path}")
    return entries


def _validate_source_archive(
    archive_path: Path,
    archive_root: str,
    excludes: list[str],
) -> None:
    try:
        with tarfile.open(archive_path, mode="r:*") as archive:
            members = archive.getmembers()
    except (OSError, tarfile.TarError) as error:
        raise ValidationError(f"源码归档无效：{error}") from error
    top_levels: set[str] = set()
    for member in members:
        normalized = member.name.replace("\\", "/").lstrip("./")
        if not normalized:
            continue
        top_levels.add(normalized.split("/", 1)[0])
        if _archive_relative_path(normalized, archive_root) is None:
            raise ValidationError(f"源码归档成员越过固定顶层根：{member.name}")
    expected_top = archive_root.rstrip("/")
    if top_levels != {expected_top}:
        raise ValidationError("源码归档必须且只能包含固定 commit 对应的顶层根。")

    selected = set(overlay_members(members, archive_root, excludes))
    for exclude in excludes:
        matching = {
            relative
            for member in members
            if (relative := _archive_relative_path(member.name, archive_root))
            and _matches_exclude(relative, exclude)
        }
        if not matching:
            raise ValidationError(f"overlayExcludes 未命中源码归档条目：{exclude}")
        if matching & selected:
            raise ValidationError(f"overlayExcludes 条目仍会进入构建 overlay：{exclude}")


def _archive_relative_path(name: str, archive_root: str) -> str | None:
    normalized = name.replace("\\", "/").lstrip("./")
    root = archive_root.rstrip("/")
    if normalized == root:
        return ""
    prefix = f"{root}/"
    if not normalized.startswith(prefix):
        return None
    relative = normalized[len(prefix):]
    try:
        return _safe_relative_path(relative.rstrip("/"), "archive member") if relative else ""
    except ValidationError:
        return None


def _matches_exclude(relative: str, exclude: str) -> bool:
    normalized = exclude.rstrip("/")
    return relative == normalized or (exclude.endswith("/") and relative.startswith(f"{normalized}/"))


def _safe_relative_path(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ValidationError(f"{field} 必须是安全的 POSIX 相对路径。")
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise ValidationError(f"{field} 必须是安全的 POSIX 相对路径。")
    return value


def _inside_cache(cache_root: Path, relative: str) -> Path:
    safe = _safe_relative_path(relative, "cachePath")
    candidate = cache_root.joinpath(*PurePosixPath(safe).parts)
    try:
        candidate.resolve(strict=True).relative_to(cache_root.resolve(strict=True))
    except (OSError, ValueError):
        raise ValidationError(f"cachePath 不存在或越过缓存根：{relative}") from None
    return candidate


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    project_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description="离线验证 HeyGem 本地构建缓存。")
    parser.add_argument(
        "--lock",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "sources.lock.json",
    )
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=project_root / "artifacts" / "koubo-heygem-build-cache",
    )
    args = parser.parse_args(argv)
    try:
        validate_build_cache(args.lock, args.cache_root)
    except ValidationError as error:
        print(f"FAILED: {error}", file=sys.stderr)
        return 1
    print("OK: HeyGem build cache matches sources.lock.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
