import tempfile
import unittest
from pathlib import Path

from vendor_runtime.job import _finalize_result, _install_video_writer, write_video


class _Service:
    write_video = None


class VendorRuntimeJobTests(unittest.TestCase):
    def test_installs_picklable_module_level_writer(self) -> None:
        service = _Service()

        _install_video_writer(service, "/usr/bin/ffmpeg")

        self.assertIs(service.write_video, write_video)
        self.assertEqual(write_video.__qualname__, "write_video")

    def test_finalizes_only_the_controlled_task_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            temp_root = root / "temp"
            result_root = root / "result"
            temp_root.mkdir()
            result_root.mkdir()
            generated = temp_root / "task-r.mp4"
            generated.write_bytes(b"video")

            result = _finalize_result(temp_root, result_root, "task")

            self.assertEqual(result, (result_root / "task-r.mp4").resolve())
            self.assertEqual(result.read_bytes(), b"video")
            self.assertFalse(generated.exists())

    def test_rejects_missing_or_empty_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            temp_root = root / "temp"
            result_root = root / "result"
            temp_root.mkdir()
            result_root.mkdir()
            (temp_root / "task-r.mp4").touch()

            with self.assertRaisesRegex(RuntimeError, "不存在或为空"):
                _finalize_result(temp_root, result_root, "task")


if __name__ == "__main__":
    unittest.main()
