from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from typing import Any
import json
import os
import time
import urllib.error
import urllib.request


UPSTREAM = os.environ.get(
    "OPENAI_CAPTURE_UPSTREAM",
    "http://127.0.0.1:8000",
)

HOST = os.environ.get(
    "OPENAI_CAPTURE_HOST",
    "127.0.0.1",
)

PORT = int(
    os.environ.get(
        "OPENAI_CAPTURE_PORT",
        "8002",
    )
)

LOG_FILE = Path(
    os.environ.get(
        "OPENAI_CAPTURE_LOG",
        "/tmp/qwen-capture/events.jsonl",
    )
)

LOCK = Lock()

LOG_FILE.parent.mkdir(
    parents=True,
    exist_ok=True,
)

LOG_FILE.touch(
    exist_ok=True,
)


def parse_value(data: bytes) -> Any:
    text = data.decode(
        "utf-8",
        errors="replace",
    )

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "_raw": text,
        }


def append_event(event: dict[str, Any]) -> None:
    encoded = json.dumps(
        event,
        ensure_ascii=False,
        separators=(",", ":"),
    )

    with LOCK:
        with LOG_FILE.open(
            "a",
            encoding="utf-8",
        ) as file:
            file.write(
                encoded + "\n"
            )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(
        self,
        *_: Any,
    ) -> None:
        return

    def send_body(
        self,
        status: int,
        body: bytes,
        content_type: str = "application/json",
    ) -> None:
        self.send_response(status)
        self.send_header(
            "Content-Type",
            content_type,
        )
        self.send_header(
            "Content-Length",
            str(len(body)),
        )
        self.send_header(
            "Connection",
            "close",
        )
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_body(
                200,
                json.dumps(
                    {"status": "ok"}
                ).encode(),
            )
            return

        self.send_body(
            404,
            json.dumps(
                {"error": "not_found"}
            ).encode(),
        )

    def do_POST(self) -> None:
        try:
            length = int(
                self.headers.get(
                    "Content-Length",
                    "0",
                )
            )
        except ValueError:
            self.send_body(
                400,
                json.dumps({
                    "error": "invalid_content_length",
                }).encode(),
            )
            return

        request_body = self.rfile.read(length)
        started = time.time()

        status = 502
        response_body = b""
        response_type = "application/json"

        upstream_request = urllib.request.Request(
            f"{UPSTREAM}{self.path}",
            data=request_body,
            method="POST",
            headers={
                "Content-Type": self.headers.get(
                    "Content-Type",
                    "application/json",
                ),
                "Accept": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(
                upstream_request,
                timeout=600,
            ) as response:
                status = response.status
                response_body = response.read()
                response_type = response.headers.get(
                    "Content-Type",
                    "application/json",
                )

        except urllib.error.HTTPError as error:
            status = error.code
            response_body = error.read()
            response_type = error.headers.get(
                "Content-Type",
                "application/json",
            )

        except Exception as error:
            status = 502
            response_body = json.dumps({
                "error": "proxy_upstream_failed",
                "message": type(error).__name__,
            }).encode()

        append_event({
            "timestamp": time.time(),
            "durationMs": round(
                (time.time() - started) * 1000
            ),
            "path": self.path,
            "status": status,
            "request": parse_value(
                request_body
            ),
            "response": parse_value(
                response_body
            ),
        })

        self.send_body(
            status,
            response_body,
            response_type,
        )


print(
    f"Capture proxy listening on {HOST}:{PORT}; "
    f"upstream={UPSTREAM}; log={LOG_FILE}",
    flush=True,
)

ThreadingHTTPServer(
    (HOST, PORT),
    Handler,
).serve_forever()
