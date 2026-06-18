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
        if self.path == "/refine":
            self._handle_refine()
            return

        if self.path == "/infill":
            self._handle_infill()
            return

        if self.path == "/resolve-conflict":
            self._handle_resolve_conflict()
            return

        self._send_json(404, {"ok": False, "error": "not_found"})

    def _handle_refine(self):
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

    def _handle_infill(self):
        started = time.time()
        payload = self._read_json()
        if payload is None:
            self._send_json(400, {"ok": False, "error": "invalid_json"})
            return

        request_id = payload.get("requestId")
        region = payload.get("region")
        prompt = payload.get("prompt")
        if not isinstance(request_id, str) or not isinstance(region, str) or not isinstance(prompt, str):
            self._send_json(400, {"ok": False, "error": "invalid_infill_request"})
            return

        # Infill mock'u gerçek üretim yapmaz; region ve prompt bilgisinden deterministik
        # bir içerik döndürür. Bu endpoint'in amacı dLLM'in maskeli tek bir alanı
        # doldurma davranışını TS/Python sınırında test etmektir.
        latency_ms = int((time.time() - started) * 1000)
        self._send_json(
            200,
            {
                "requestId": request_id,
                "region": region,
                "content": f"mock infill for {region}: {prompt[:80]}",
                "engineName": WORKER_NAME,
                "latencyMs": latency_ms,
            },
        )

    def _handle_resolve_conflict(self):
        started = time.time()
        payload = self._read_json()
        if payload is None:
            self._send_json(400, {"ok": False, "error": "invalid_json"})
            return

        request_id = payload.get("requestId")
        conflict_id = payload.get("conflictId")
        workspace = payload.get("workspace")
        if not isinstance(request_id, str) or not isinstance(conflict_id, str) or not isinstance(workspace, dict):
            self._send_json(400, {"ok": False, "error": "invalid_conflict_request"})
            return

        # Conflict mock'u evidence tartışması yapmaz; sadece contract'ın doğru
        # çalıştığını gösterir. Gerçek dLLM geldiğinde bu endpoint iki çelişkili
        # claim'i workspace evidence'ı ile karşılaştırıp çözüm önerecek.
        latency_ms = int((time.time() - started) * 1000)
        self._send_json(
            200,
            {
                "requestId": request_id,
                "conflictId": conflict_id,
                "resolution": "mock resolution: keep the evidence-backed claim and remask the weaker region",
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
