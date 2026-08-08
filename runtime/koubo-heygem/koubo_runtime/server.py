from __future__ import annotations

import json
import signal
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import API_DIALECT, RUNTIME_NAME, RUNTIME_VERSION
from .heygem_engine import EngineError, HeyGemEngine
from .protocol import ProtocolError, parse_render_request

MAX_REQUEST_BYTES = 64 * 1024


class RuntimeState:
    def __init__(self, engine: HeyGemEngine) -> None:
        self.engine = engine
        self.render_lock = threading.Lock()

    def health(self) -> tuple[int, dict[str, Any]]:
        readiness = self.engine.inspect()
        body: dict[str, Any] = {
            "schemaVersion": 1,
            "name": RUNTIME_NAME,
            "version": RUNTIME_VERSION,
            "apiDialect": API_DIALECT,
            "status": "rendering" if self.render_lock.locked() else ("ready" if readiness.ready else "failed"),
        }
        if not readiness.ready:
            body["error"] = {"code": readiness.code or "runtime_not_ready", "message": readiness.message}
            return HTTPStatus.SERVICE_UNAVAILABLE, body
        return HTTPStatus.OK, body


def create_handler(state: RuntimeState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "KouboRuntime/1"

        def do_GET(self) -> None:
            if self.path != "/health":
                self._json(HTTPStatus.NOT_FOUND, _error("not_found", "接口不存在。"))
                return
            status, body = state.health()
            self._json(status, body)

        def do_POST(self) -> None:
            if self.path != "/render":
                self._json(HTTPStatus.NOT_FOUND, _error("not_found", "接口不存在。"))
                return
            try:
                request = parse_render_request(self._read_json())
            except ProtocolError as error:
                self._json(HTTPStatus.BAD_REQUEST, _error(error.code, error.message))
                return
            if not state.render_lock.acquire(blocking=False):
                self._json(HTTPStatus.CONFLICT, _error("runtime_busy", "KouboRuntime 正在生成另一个视频。"))
                return
            try:
                state.engine.render(request)
                self._json(HTTPStatus.OK, {"status": "ok", "outputPath": request.output_path_raw})
            except EngineError as error:
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, _error(error.code, error.message))
            except Exception:
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, _error("runtime_failed", "数字人运行环境发生未分类错误。"))
            finally:
                state.render_lock.release()

        def _read_json(self) -> Any:
            try:
                length = int(self.headers.get("content-length") or "")
            except ValueError:
                raise ProtocolError("invalid_request", "Content-Length 无效。") from None
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ProtocolError("request_too_large", "请求体为空或超过 64 KiB。")
            body = self.rfile.read(length)
            if len(body) != length:
                raise ProtocolError("invalid_request", "请求体不完整。")
            try:
                return json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise ProtocolError("invalid_json", "请求体不是有效 UTF-8 JSON。") from None

        def _json(self, status: int, body: dict[str, Any]) -> None:
            encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(encoded)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except BrokenPipeError:
                pass

        def log_message(self, format: str, *args: object) -> None:
            return

    return Handler


def serve() -> None:
    state = RuntimeState(HeyGemEngine())
    server = ThreadingHTTPServer(("127.0.0.1", 8383), create_handler(state))

    def stop(_signum: int, _frame: object) -> None:
        state.engine.cancel_active()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever(poll_interval=0.25)
    server.server_close()


def _error(code: str, message: str) -> dict[str, Any]:
    return {"status": "failed", "error": {"code": code, "message": message}}


if __name__ == "__main__":
    serve()
