from __future__ import annotations

import json
import io
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from koubo_runtime.heygem_engine import (  # noqa: E402
    EngineError,
    FixedCommandRunner,
    HeyGemEngine,
    HttpHeyGemClient,
    QueryResult,
)
from koubo_runtime.protocol import RenderRequest  # noqa: E402


class FakeClient:
    def __init__(self, results: list[QueryResult] | None = None, healthy: bool = True) -> None:
        self.results = list(results or [])
        self.healthy = healthy
        self.submissions: list[dict[str, object]] = []
        self.cancelled: list[str] = []
        self.cancel_error: EngineError | None = None
        self.submit_error: EngineError | None = None
        self.query_error: EngineError | None = None

    def health(self) -> bool:
        return self.healthy

    def submit(self, **kwargs: object) -> None:
        self.submissions.append(kwargs)
        if self.submit_error:
            raise self.submit_error

    def query(self, _code: str) -> QueryResult:
        if self.query_error:
            error = self.query_error
            self.query_error = None
            raise error
        return self.results.pop(0) if self.results else QueryResult("running")

    def cancel(self, code: str) -> None:
        self.cancelled.append(code)
        if self.cancel_error:
            raise self.cancel_error


class FakeRunner:
    def __init__(
        self,
        returncode: int = 0,
        stdout: str = "video\n",
        reset_returncode: int = 0,
    ) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.reset_returncode = reset_returncode
        self.calls: list[tuple[tuple[str, ...], float]] = []

    def run(self, argv: tuple[str, ...], timeout: float) -> subprocess.CompletedProcess[str]:
        self.calls.append((tuple(argv), timeout))
        returncode = self.reset_returncode if tuple(argv)[-1:] == ("reset-worker",) else self.returncode
        return subprocess.CompletedProcess(argv, returncode, self.stdout, "")


class HttpQueryClient(HttpHeyGemClient):
    def __init__(self) -> None:
        super().__init__()
        self.cancelled: list[str] = []

    def health(self) -> bool:
        return True

    def submit(self, **_kwargs: object) -> None:
        return

    def cancel(self, code: str) -> None:
        self.cancelled.append(code)


def create_vendor(root: Path) -> None:
    (root / "models").mkdir(parents=True)
    (root / "runtime").mkdir()
    (root / "models" / "face.bin").write_bytes(b"model")
    (root / "runtime" / "adapter.py").write_text("# vendor-owned adapter\n", encoding="utf-8")
    (root / "vendor-manifest.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "engine": "HeyGem",
            "files": [
                {"path": "runtime/adapter.py", "kind": "runtime"},
                {"path": "models/face.bin", "kind": "model"},
            ],
        }),
        encoding="utf-8",
    )


class HeyGemEngineTest(unittest.TestCase):
    def test_readiness_fails_closed_without_vendor_assets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            engine = HeyGemEngine(
                client=FakeClient(),
                runner=FakeRunner(),
                vendor_root=Path(directory) / "missing",
            )
            readiness = engine.inspect()
            self.assertFalse(readiness.ready)
            self.assertEqual(readiness.code, "vendor_assets_missing")

    def test_readiness_requires_runtime_and_model_and_internal_health(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            vendor = Path(directory) / "vendor"
            create_vendor(vendor)
            engine = HeyGemEngine(
                client=FakeClient(healthy=False),
                runner=FakeRunner(),
                vendor_root=vendor,
            )
            readiness = engine.inspect()
            self.assertFalse(readiness.ready)
            self.assertEqual(readiness.code, "internal_runtime_unavailable")

    def test_submit_query_probe_and_atomic_result_copy_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "vendor"
            results = root / "results"
            output = root / "workspace" / "candidate.mp4"
            output.parent.mkdir()
            results.mkdir()
            source = results / "job.mp4"
            source.write_bytes(b"valid-video")
            create_vendor(vendor)
            client = FakeClient([
                QueryResult("running"),
                QueryResult("success", str(source)),
            ])
            runner = FakeRunner()
            engine = HeyGemEngine(
                client=client,
                runner=runner,
                vendor_root=vendor,
                result_root=results,
                poll_interval_seconds=0,
            )
            request = RenderRequest(
                project_id="project-1",
                audio_path=root / "voice.wav",
                avatar_path=root / "avatar.mp4",
                output_path=output,
                output_path_raw="/mnt/d/workspace/candidate.mp4",
                mode="cinema",
            )

            engine.render(request)

            self.assertEqual(output.read_bytes(), b"valid-video")
            self.assertEqual(len(client.submissions), 1)
            self.assertEqual(client.submissions[0]["audio_path"], str(request.audio_path))
            self.assertEqual(client.submissions[0]["video_path"], str(request.avatar_path))
            self.assertTrue(client.submissions[0]["cinema"])
            argv, timeout = runner.calls[0]
            self.assertEqual(argv[0], "/usr/bin/ffprobe")
            self.assertEqual(argv[-1], str(source))
            self.assertEqual(timeout, 30.0)
            self.assertEqual(list(output.parent.glob("*.tmp")), [])

    def test_rejects_result_outside_trusted_result_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "vendor"
            results = root / "results"
            results.mkdir()
            outside = root / "outside.mp4"
            outside.write_bytes(b"video")
            create_vendor(vendor)
            engine = HeyGemEngine(
                client=FakeClient([QueryResult("success", str(outside))]),
                runner=FakeRunner(),
                vendor_root=vendor,
                result_root=results,
                poll_interval_seconds=0,
            )
            request = RenderRequest(
                "p", root / "a.wav", root / "v.mp4",
                root / "candidate.mp4", "/mnt/d/candidate.mp4", "standard",
            )
            with self.assertRaises(EngineError) as raised:
                engine.render(request)
            self.assertEqual(raised.exception.code, "result_path_escape")
            self.assertFalse(request.output_path.exists())

    def test_timeout_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "vendor"
            results = root / "results"
            results.mkdir()
            create_vendor(vendor)
            client = FakeClient()
            engine = HeyGemEngine(
                client=client,
                runner=FakeRunner(),
                vendor_root=vendor,
                result_root=results,
                timeout_seconds=-1,
                poll_interval_seconds=0,
            )
            request = RenderRequest(
                "p", root / "a.wav", root / "v.mp4",
                root / "candidate.mp4", "/mnt/d/candidate.mp4", "fast",
            )
            with self.assertRaises(EngineError) as raised:
                engine.render(request)
            self.assertEqual(raised.exception.code, "task_timeout")
            self.assertEqual(len(client.cancelled), 1)

    def test_user_cancel_best_effort_cancels_active_internal_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "vendor"
            results = root / "results"
            results.mkdir()
            create_vendor(vendor)
            client = FakeClient()
            engine = HeyGemEngine(
                client=client,
                runner=FakeRunner(),
                vendor_root=vendor,
                result_root=results,
                poll_interval_seconds=0,
            )
            request = RenderRequest(
                "p", root / "a.wav", root / "v.mp4",
                root / "candidate.mp4", "/mnt/d/candidate.mp4", "fast",
            )

            original_query = client.query

            def cancel_during_query(code: str) -> QueryResult:
                engine.cancel_active()
                return original_query(code)

            client.query = cancel_during_query  # type: ignore[method-assign]
            with self.assertRaises(EngineError) as raised:
                engine.render(request)
            self.assertEqual(raised.exception.code, "task_cancelled")
            self.assertEqual(len(client.cancelled), 1)

    def test_cancel_failure_resets_worker_and_requires_health_before_cancelled(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "vendor"
            results = root / "results"
            results.mkdir()
            create_vendor(vendor)
            client = FakeClient()
            client.cancel_error = EngineError("task_cancel_failed", "cancel disconnected")
            runner = FakeRunner(reset_returncode=0)
            engine = HeyGemEngine(
                client=client,
                runner=runner,
                vendor_root=vendor,
                result_root=results,
                poll_interval_seconds=0,
                recovery_attempts=1,
                recovery_interval_seconds=0,
            )
            request = RenderRequest(
                "p", root / "a.wav", root / "v.mp4",
                root / "candidate.mp4", "/mnt/d/candidate.mp4", "fast",
            )
            original_query = client.query

            def cancel_during_query(code: str) -> QueryResult:
                engine.cancel_active()
                return original_query(code)

            client.query = cancel_during_query  # type: ignore[method-assign]
            with self.assertRaises(EngineError) as raised:
                engine.render(request)
            self.assertEqual(raised.exception.code, "task_cancelled")
            self.assertIn(
                ("/opt/koubo/heygem/vendor/bin/heygem-supervisor", "reset-worker"),
                [call[0] for call in runner.calls],
            )

    def test_cancel_and_reset_failure_returns_runtime_recovery_failed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "vendor"
            results = root / "results"
            results.mkdir()
            create_vendor(vendor)
            client = FakeClient()
            client.cancel_error = EngineError("task_cancel_failed", "cancel disconnected")
            runner = FakeRunner(reset_returncode=1)
            engine = HeyGemEngine(
                client=client,
                runner=runner,
                vendor_root=vendor,
                result_root=results,
                timeout_seconds=-1,
                poll_interval_seconds=0,
                recovery_attempts=1,
                recovery_interval_seconds=0,
            )
            request = RenderRequest(
                "p", root / "a.wav", root / "v.mp4",
                root / "candidate.mp4", "/mnt/d/candidate.mp4", "fast",
            )
            with self.assertRaises(EngineError) as raised:
                engine.render(request)
            self.assertEqual(raised.exception.code, "runtime_recovery_failed")

    def test_uncertain_submit_and_query_failures_terminate_or_reset_worker(self) -> None:
        for phase in ("submit", "query"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                vendor = root / "vendor"
                results = root / "results"
                results.mkdir()
                create_vendor(vendor)
                client = FakeClient()
                uncertain = EngineError("internal_runtime_unavailable", f"{phase} disconnected")
                if phase == "submit":
                    client.submit_error = uncertain
                else:
                    client.query_error = uncertain
                client.cancel_error = EngineError("task_cancel_failed", "cancel disconnected")
                runner = FakeRunner(reset_returncode=0)
                engine = HeyGemEngine(
                    client=client,
                    runner=runner,
                    vendor_root=vendor,
                    result_root=results,
                    poll_interval_seconds=0,
                    recovery_attempts=1,
                    recovery_interval_seconds=0,
                )
                request = RenderRequest(
                    "p", root / "a.wav", root / "v.mp4",
                    root / "candidate.mp4", "/mnt/d/candidate.mp4", "fast",
                )
                with self.assertRaises(EngineError) as raised:
                    engine.render(request)
                self.assertEqual(raised.exception.code, "internal_runtime_unavailable")
                self.assertEqual(len(client.cancelled), 1)
                self.assertIn(
                    ("/opt/koubo/heygem/vendor/bin/heygem-supervisor", "reset-worker"),
                    [call[0] for call in runner.calls],
                )

    def test_http_client_keeps_polling_when_progress_is_100_but_status_is_running(self) -> None:
        client = HttpHeyGemClient()
        with patch.object(
            client,
            "_request",
            return_value=(200, {"code": 10000, "data": {"status": 1, "progress": 100, "result": "x.mp4"}}),
        ):
            self.assertEqual(client.query("job").status, "running")

    def test_http_error_preserves_status_for_submit_and_query_classification(self) -> None:
        client = HttpHeyGemClient()
        for operation, expected in (
            (lambda: client.submit(audio_path="/a.wav", video_path="/v.mp4", code="job", cinema=False), "task_submit_failed"),
            (lambda: client.query("job"), "task_query_failed"),
        ):
            error = urllib.error.HTTPError(
                "http://127.0.0.1:8384/easy",
                503,
                "unavailable",
                {},
                io.BytesIO(b'{"message":"busy"}'),
            )
            with self.subTest(expected=expected), patch("urllib.request.urlopen", side_effect=error):
                with self.assertRaises(EngineError) as raised:
                    operation()
                self.assertEqual(raised.exception.code, expected)

    def test_real_query_http_error_is_cleaned_up_after_successful_submit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "vendor"
            results = root / "results"
            results.mkdir()
            create_vendor(vendor)
            client = HttpQueryClient()
            engine = HeyGemEngine(
                client=client,
                runner=FakeRunner(),
                vendor_root=vendor,
                result_root=results,
                poll_interval_seconds=0,
            )
            request = RenderRequest(
                "p", root / "a.wav", root / "v.mp4",
                root / "candidate.mp4", "/mnt/d/candidate.mp4", "fast",
            )
            error = urllib.error.HTTPError(
                "http://127.0.0.1:8384/easy/query",
                503,
                "unavailable",
                {},
                io.BytesIO(b'{"message":"busy"}'),
            )
            with patch("urllib.request.urlopen", side_effect=error):
                with self.assertRaises(EngineError) as raised:
                    engine.render(request)
            self.assertEqual(raised.exception.code, "task_query_failed")
            self.assertEqual(len(client.cancelled), 1)

    def test_oversized_query_error_response_is_cleaned_up_after_submit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor = root / "vendor"
            results = root / "results"
            results.mkdir()
            create_vendor(vendor)
            client = HttpQueryClient()
            engine = HeyGemEngine(
                client=client,
                runner=FakeRunner(),
                vendor_root=vendor,
                result_root=results,
                poll_interval_seconds=0,
            )
            request = RenderRequest(
                "p", root / "a.wav", root / "v.mp4",
                root / "candidate.mp4", "/mnt/d/candidate.mp4", "fast",
            )
            error = urllib.error.HTTPError(
                "http://127.0.0.1:8384/easy/query",
                500,
                "large",
                {},
                io.BytesIO(b"x" * (64 * 1024 + 1)),
            )
            with patch("urllib.request.urlopen", side_effect=error):
                with self.assertRaises(EngineError) as raised:
                    engine.render(request)
            self.assertEqual(raised.exception.code, "internal_response_too_large")
            self.assertEqual(len(client.cancelled), 1)

    def test_fixed_command_runner_never_uses_a_shell(self) -> None:
        with patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, "", "")
            FixedCommandRunner().run(("/usr/bin/ffprobe", "--version"), 3)
            _, kwargs = run.call_args
            self.assertIs(kwargs["shell"], False)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/ffprobe", "--version"])


if __name__ == "__main__":
    unittest.main()
