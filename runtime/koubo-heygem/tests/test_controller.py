from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from koubo_runtime import internal_health  # noqa: E402
from koubo_runtime.controller import (  # noqa: E402
    BRIDGE_ARGV,
    SUPERVISOR,
    ControllerError,
    RuntimeController,
    SystemOperations,
)


class FakeOperations:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.pid: int | None = None
        self.alive: set[int] = set()
        self.health: list[bool] = [True]
        self.supervisor_start_ok = True
        self.start_bridge_error: Exception | None = None
        self.write_pid_error: Exception | None = None

    def supervisor_exists(self) -> bool:
        self.events.append("supervisor_exists")
        return True

    def supervisor(self, action: str) -> bool:
        self.events.append(f"supervisor:{action}")
        return self.supervisor_start_ok if action == "start" else True

    def internal_healthy(self) -> bool:
        self.events.append("health")
        return self.health.pop(0) if self.health else True

    def read_pid(self) -> int | None:
        self.events.append("read_pid")
        return self.pid

    def write_pid(self, pid: int) -> None:
        self.events.append(f"write_pid:{pid}")
        if self.write_pid_error:
            raise self.write_pid_error
        self.pid = pid

    def clear_pid(self) -> None:
        self.events.append("clear_pid")
        self.pid = None

    def bridge_alive(self, pid: int | None) -> bool:
        self.events.append(f"bridge_alive:{pid}")
        return pid in self.alive if pid is not None else False

    def start_bridge(self) -> int:
        self.events.append("start_bridge")
        if self.start_bridge_error:
            raise self.start_bridge_error
        self.alive.add(321)
        return 321

    def stop_bridge(self, pid: int | None) -> None:
        self.events.append(f"stop_bridge:{pid}")
        if pid is not None:
            self.alive.discard(pid)


class ControllerContractTest(unittest.TestCase):
    def test_partial_supervisor_start_failure_executes_full_rollback(self) -> None:
        operations = FakeOperations()
        operations.supervisor_start_ok = False
        with self.assertRaises(ControllerError):
            RuntimeController(operations).start()
        self.assertIn("stop_bridge:None", operations.events)
        self.assertIn("clear_pid", operations.events)
        self.assertEqual(operations.events[-1], "supervisor:stop")

    def test_health_pid_and_bridge_failures_each_execute_full_rollback(self) -> None:
        cases = ("health", "pid", "bridge")
        for failure in cases:
            operations = FakeOperations()
            if failure == "health":
                operations.health = [False]
            elif failure == "pid":
                operations.write_pid_error = OSError("disk full")
            else:
                # A started process that exits before the post-start check.
                original = operations.start_bridge

                def exited_bridge() -> int:
                    pid = original()
                    operations.alive.discard(pid)
                    return pid

                operations.start_bridge = exited_bridge  # type: ignore[method-assign]
            with self.subTest(failure=failure), self.assertRaises(ControllerError):
                RuntimeController(operations).start()
            self.assertIn("clear_pid", operations.events)
            self.assertEqual(operations.events[-1], "supervisor:stop")
            self.assertEqual(operations.pid, None)
            self.assertEqual(operations.alive, set())

    def test_existing_bridge_with_dead_8384_is_fully_restarted(self) -> None:
        operations = FakeOperations()
        operations.pid = 100
        operations.alive.add(100)
        operations.health = [False, True]
        RuntimeController(operations).start()
        self.assertLess(operations.events.index("stop_bridge:100"), operations.events.index("supervisor:stop"))
        self.assertLess(operations.events.index("supervisor:stop"), operations.events.index("supervisor:start"))
        self.assertEqual(operations.pid, 321)
        self.assertIn(321, operations.alive)

    def test_system_operations_use_only_fixed_argv_without_shell(self) -> None:
        with patch("subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0)
            self.assertTrue(SystemOperations().supervisor("reset-worker"))
        self.assertEqual(run.call_args.args[0], [SUPERVISOR, "reset-worker"])
        self.assertIs(run.call_args.kwargs["shell"], False)
        self.assertEqual(BRIDGE_ARGV, (
            "/opt/koubo/venv/bin/python", "-m", "koubo_runtime.server",
        ))

    def test_internal_health_checks_only_fixed_loopback_endpoint(self) -> None:
        response = MagicMock()
        response.status = 200
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        with patch("urllib.request.urlopen", return_value=response) as open_url:
            self.assertTrue(internal_health.wait_until_healthy())
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8384/health")


if __name__ == "__main__":
    unittest.main()
