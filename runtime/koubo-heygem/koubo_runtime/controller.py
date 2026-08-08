from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Protocol

from .internal_health import wait_until_healthy

PID_FILE = Path("/run/koubo-runtime.pid")
LOG_DIR = Path("/var/log/koubo-runtime")
LOG_FILE = LOG_DIR / "service.log"
PYTHON = "/opt/koubo/venv/bin/python"
SUPERVISOR = "/opt/koubo/heygem/vendor/bin/heygem-supervisor"
BRIDGE_ARGV = (PYTHON, "-m", "koubo_runtime.server")


class ControllerError(RuntimeError):
    pass


class ControllerOperations(Protocol):
    def supervisor_exists(self) -> bool: ...
    def supervisor(self, action: str) -> bool: ...
    def internal_healthy(self) -> bool: ...
    def read_pid(self) -> int | None: ...
    def write_pid(self, pid: int) -> None: ...
    def clear_pid(self) -> None: ...
    def bridge_alive(self, pid: int | None) -> bool: ...
    def start_bridge(self) -> int: ...
    def stop_bridge(self, pid: int | None) -> None: ...


class SystemOperations:
    def supervisor_exists(self) -> bool:
        return Path(SUPERVISOR).is_file() and os.access(SUPERVISOR, os.X_OK)

    def supervisor(self, action: str) -> bool:
        if action not in {"start", "stop", "reset-worker"}:
            raise ValueError("unsupported fixed supervisor action")
        result = subprocess.run(
            [SUPERVISOR, action],
            shell=False,
            check=False,
            capture_output=True,
            timeout=120,
        )
        return result.returncode == 0

    def internal_healthy(self) -> bool:
        return wait_until_healthy()

    def read_pid(self) -> int | None:
        try:
            value = PID_FILE.read_text(encoding="ascii").strip()
            return int(value) if value.isascii() and value.isdigit() else None
        except (OSError, ValueError):
            return None

    def write_pid(self, pid: int) -> None:
        temp = PID_FILE.with_name(f"{PID_FILE.name}.{pid}.tmp")
        try:
            temp.write_text(f"{pid}\n", encoding="ascii")
            os.replace(temp, PID_FILE)
        finally:
            temp.unlink(missing_ok=True)

    def clear_pid(self) -> None:
        PID_FILE.unlink(missing_ok=True)

    def bridge_alive(self, pid: int | None) -> bool:
        if not pid or pid <= 0:
            return False
        try:
            os.kill(pid, 0)
            command = Path(f"/proc/{pid}/cmdline").read_bytes()
            return b"koubo_runtime.server" in command
        except OSError:
            return False

    def start_bridge(self) -> int:
        LOG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        log = LOG_FILE.open("ab", buffering=0)
        try:
            child = subprocess.Popen(
                list(BRIDGE_ARGV),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                shell=False,
                start_new_session=True,
                close_fds=True,
            )
            return child.pid
        finally:
            log.close()

    def stop_bridge(self, pid: int | None) -> None:
        if not self.bridge_alive(pid):
            return
        assert pid is not None
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            return
        for _ in range(40):
            if not self.bridge_alive(pid):
                return
            time.sleep(0.5)
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass


class RuntimeController:
    def __init__(self, operations: ControllerOperations | None = None) -> None:
        self.operations = operations or SystemOperations()

    def start(self) -> None:
        if not self.operations.supervisor_exists():
            raise ControllerError("HeyGem supervisor is missing or not executable.")

        existing_pid = self.operations.read_pid()
        if self.operations.bridge_alive(existing_pid):
            if self.operations.internal_healthy():
                return
            self._stop_components(existing_pid)
        elif existing_pid is not None:
            self.operations.clear_pid()

        bridge_pid: int | None = None
        try:
            # A non-zero start can still mean the supervisor partially created a worker.
            # Rollback always calls the fixed stop action.
            if not self.operations.supervisor("start"):
                raise ControllerError("HeyGem supervisor failed to start.")
            if not self.operations.internal_healthy():
                raise ControllerError("HeyGem internal service did not become healthy.")
            bridge_pid = self.operations.start_bridge()
            self.operations.write_pid(bridge_pid)
            if not self.operations.bridge_alive(bridge_pid):
                raise ControllerError("KouboRuntime bridge failed to start.")
        except Exception as error:
            self._stop_components(bridge_pid)
            if isinstance(error, ControllerError):
                raise
            raise ControllerError(f"KouboRuntime start failed: {error}") from error

    def stop(self) -> None:
        self._stop_components(self.operations.read_pid())

    def _stop_components(self, bridge_pid: int | None) -> None:
        try:
            self.operations.stop_bridge(bridge_pid)
        finally:
            try:
                self.operations.clear_pid()
            finally:
                self.operations.supervisor("stop")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in {"start", "stop"}:
        print("usage: koubo-runtime start|stop", file=sys.stderr)
        return 2
    try:
        controller = RuntimeController()
        controller.start() if argv[1] == "start" else controller.stop()
        return 0
    except ControllerError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
