from __future__ import annotations

import copy
import hashlib
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from validate_build_cache import (  # noqa: E402
    EXPECTED_ARCHIVE_ROOT,
    EXPECTED_COMMIT,
    ValidationError,
    overlay_members,
    validate_build_cache,
)


EXCLUDES = [
    ".DS_Store",
    "1.jpeg",
    "README_tts_f2f.MD",
    "app.py",
    "example/",
    "inference_from_text.sh",
]


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_archive(path: Path, root: str = EXPECTED_ARCHIVE_ROOT) -> None:
    members = {
        ".DS_Store": b"metadata",
        "1.jpeg": b"demo image",
        "README_tts_f2f.MD": b"demo readme",
        "app.py": b"demo app",
        "example/demo.mp4": b"demo video",
        "inference_from_text.sh": b"demo script",
        "runtime/adapter.py": b"retained runtime",
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, "w:gz") as archive:
        for relative, content in members.items():
            info = tarfile.TarInfo(f"{root.rstrip('/')}/{relative}")
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))


def create_fixture(root: Path) -> tuple[Path, Path, dict[str, object]]:
    cache = root / "cache"
    archive_path = cache / "source" / f"HeyGem-Linux-Python-Hack-{EXPECTED_COMMIT}.tar.gz"
    write_archive(archive_path)
    source_bytes = archive_path.read_bytes()
    models: list[dict[str, object]] = []
    for index in range(9):
        content = f"model-{index}".encode()
        cache_path = f"models/model-{index}.bin"
        file_path = cache / cache_path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(content)
        models.append({
            "url": f"https://invalid.example/model-{index}.bin",
            "cachePath": cache_path,
            "targetPath": f"models/target-{index}.bin",
            "size": len(content),
            "sha256": digest(content),
        })
    source: dict[str, object] = {
        "url": "https://invalid.example/source.tar.gz",
        "cachePath": f"source/HeyGem-Linux-Python-Hack-{EXPECTED_COMMIT}.tar.gz",
        "size": len(source_bytes),
        "sha256": digest(source_bytes),
        "archiveRoot": EXPECTED_ARCHIVE_ROOT,
        "overlayExcludes": EXCLUDES,
    }
    lock: dict[str, object] = {
        "schemaVersion": 1,
        "engine": "HeyGem",
        "usage": "local_validation_only",
        "distribution": {"redistributionAuthorized": False},
        "upstream": {"commit": EXPECTED_COMMIT},
        "sourceArchive": source,
        "models": models,
        "expectedCacheFileCount": 10,
        "expectedTotalBytes": source["size"] + sum(model["size"] for model in models),
        "forbiddenDownloads": ["MuseTalk", "Docker images", "scrfd_10g_kps.onnx"],
    }
    lock_path = root / "sources.lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    return lock_path, cache, lock


class BuildCacheValidatorTest(unittest.TestCase):
    def test_validates_complete_offline_cache_and_archive_overlay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock_path, cache, _ = create_fixture(Path(directory))
            validate_build_cache(lock_path, cache)
            with tarfile.open(cache / f"source/HeyGem-Linux-Python-Hack-{EXPECTED_COMMIT}.tar.gz") as archive:
                selected = overlay_members(archive.getmembers(), EXPECTED_ARCHIVE_ROOT, EXCLUDES)
            self.assertEqual(selected, ["runtime/adapter.py"])

    def test_rejects_part_and_other_extra_files(self) -> None:
        for relative in ("models/model-0.bin.part", "models/unlocked.bin"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                lock_path, cache, _ = create_fixture(Path(directory))
                (cache / relative).write_bytes(b"extra")
                with self.assertRaises(ValidationError):
                    validate_build_cache(lock_path, cache)

    def test_rejects_size_hash_and_total_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            lock_path, cache, lock = create_fixture(Path(directory))
            (cache / "models/model-0.bin").write_bytes(b"tampered")
            with self.assertRaises(ValidationError):
                validate_build_cache(lock_path, cache)

            lock_path, cache, lock = create_fixture(Path(directory))
            changed = copy.deepcopy(lock)
            changed["expectedTotalBytes"] = int(changed["expectedTotalBytes"]) + 1
            lock_path.write_text(json.dumps(changed), encoding="utf-8")
            with self.assertRaises(ValidationError):
                validate_build_cache(lock_path, cache)

    def test_rejects_unsafe_duplicate_and_forbidden_cache_paths(self) -> None:
        mutations = (
            lambda lock: lock["models"][0].update({"cachePath": "../escape.bin"}),
            lambda lock: lock["models"][1].update({"cachePath": lock["models"][0]["cachePath"]}),
            lambda lock: lock["models"][0].update({"cachePath": "models/MuseTalk.bin"}),
            lambda lock: lock["models"][1].update({"targetPath": lock["models"][0]["targetPath"]}),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate), tempfile.TemporaryDirectory() as directory:
                lock_path, cache, lock = create_fixture(Path(directory))
                mutate(lock)
                lock_path.write_text(json.dumps(lock), encoding="utf-8")
                with self.assertRaises(ValidationError):
                    validate_build_cache(lock_path, cache)

    def test_rejects_archive_with_wrong_or_multiple_top_level_roots(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock_path, cache, lock = create_fixture(root)
            archive_path = cache / lock["sourceArchive"]["cachePath"]
            write_archive(archive_path, "wrong-commit/")
            source = lock["sourceArchive"]
            source["size"] = archive_path.stat().st_size
            source["sha256"] = digest(archive_path.read_bytes())
            lock["expectedTotalBytes"] = source["size"] + sum(model["size"] for model in lock["models"])
            lock_path.write_text(json.dumps(lock), encoding="utf-8")
            with self.assertRaises(ValidationError):
                validate_build_cache(lock_path, cache)


if __name__ == "__main__":
    unittest.main()
