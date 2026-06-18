from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import time


WORKER_NAME = "python-mock-dllm-worker"
WORKER_VERSION = "0.1.0"


class DllmWorkerHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "workerName": WORKER_NAME,
                    "mode": "mock",
                    "version": WORKER_VERSION,
                },
            )
            return

        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if self.path != "/refine":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return

        started = time.time()
        payload = self._read_json()
        if payload is None:
            self._send_json(400, {"ok": False, "error": "invalid_json"})
            return

        workspace = payload.get("workspace")
        request_id = payload.get("requestId")
        if not isinstance(workspace, dict) or not isinstance(request_id, str):
            self._send_json(400, {"ok": False, "error": "invalid_refine_request"})
            return

        # Bu worker gerçek dLLM değildir; iki dil arasındaki HTTP/JSON sınırını test
        # eden bağımlılıksız mock'tur. Benchmark, scope policy ve verifier TS tarafında
        # kalır. Python tarafı sadece kendisine verilen workspace'i alıp sözleşmeye
        # uygun cevap döndürür.
        latency_ms = int((time.time() - started) * 1000)
        self._send_json(
            200,
            {
                "requestId": request_id,
                "workspace": workspace,
                "engineName": WORKER_NAME,
                "latencyMs": latency_ms,
            },
        )

    def _read_json(self):
        content_length = int(self.headers.get("content-length", "0"))
        raw_body = self.rfile.read(content_length)
        try:
            return json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    def _send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 8765), DllmWorkerHandler)
    print(f"{WORKER_NAME} listening on http://127.0.0.1:8765")
    server.serve_forever()


if __name__ == "__main__":
    main()
