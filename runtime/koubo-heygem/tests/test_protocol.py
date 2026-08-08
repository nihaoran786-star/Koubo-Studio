from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from koubo_runtime.protocol import ProtocolError, parse_render_request  # noqa: E402


class ProtocolTest(unittest.TestCase):
    def base_payload(self) -> dict[str, object]:
        return {
            "projectId": "project-1",
            "audioPath": "/mnt/d/work/voice.wav",
            "avatar": {
                "source": "upload",
                "id": "avatar-1",
                "assetPath": "/mnt/d/work/avatar.mp4",
            },
            "mode": "standard",
            "outputPath": "/mnt/d/work/candidate.mp4",
            "pathDialect": "wsl_mount_v1",
        }

    def test_rejects_non_wsl_path_dialect_before_touching_files(self) -> None:
        payload = self.base_payload()
        payload["pathDialect"] = "windows"
        with self.assertRaises(ProtocolError) as raised:
            parse_render_request(payload)
        self.assertEqual(raised.exception.code, "path_dialect_invalid")

    def test_rejects_library_avatar_before_touching_files(self) -> None:
        payload = self.base_payload()
        payload["avatar"] = {"source": "library", "id": "avatar-1"}
        with self.assertRaises(ProtocolError) as raised:
            parse_render_request(payload)
        self.assertEqual(raised.exception.code, "avatar_source_unsupported")

    def test_rejects_unc_windows_and_traversal_paths(self) -> None:
        for invalid in (
            r"\\server\share\voice.wav",
            r"D:\work\voice.wav",
            "/mnt/d/work/../voice.wav",
        ):
            payload = self.base_payload()
            payload["audioPath"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(ProtocolError) as raised:
                parse_render_request(payload)
            self.assertEqual(raised.exception.code, "path_invalid")


if __name__ == "__main__":
    unittest.main()
