from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from koubo_runtime.heygem_engine import EngineReadiness  # noqa: E402
from koubo_runtime.server import RuntimeState  # noqa: E402


class StubEngine:
    def __init__(self, readiness: EngineReadiness) -> None:
        self.readiness = readiness

    def inspect(self) -> EngineReadiness:
        return self.readiness


class ServerStateTest(unittest.TestCase):
    def test_health_identity_matches_managed_runtime_contract(self) -> None:
        status, body = RuntimeState(StubEngine(EngineReadiness(True))).health()
        self.assertEqual(status, 200)
        self.assertEqual(body["schemaVersion"], 1)
        self.assertEqual(body["name"], "KouboRuntime")
        self.assertEqual(body["apiDialect"], "compatible_render")
        self.assertEqual(body["status"], "ready")

    def test_health_fails_closed_with_stable_error(self) -> None:
        status, body = RuntimeState(
            StubEngine(EngineReadiness(False, "vendor_assets_missing", "missing"))
        ).health()
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "vendor_assets_missing")


if __name__ == "__main__":
    unittest.main()
