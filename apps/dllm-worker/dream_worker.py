from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import time

import torch
from transformers import AutoModel, AutoTokenizer


MODEL_PATH = os.environ.get("DREAM_CODER_MODEL", "Dream-org/Dream-Coder-v0-Instruct-7B")
WORKER_NAME = "dream-coder-dllm-worker"
WORKER_VERSION = "0.1.0"
DEFAULT_HOST = os.environ.get("DLLM_WORKER_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("DLLM_WORKER_PORT", "8765"))


def configure_cache():
    # Model dosyaları büyük olduğu için cache'i /workspace altında tutuyoruz.
    # RunPod pod stop edildiğinde /workspace kalırsa aynı modeli tekrar indirmeyiz.
    hf_home = os.environ.get("HF_HOME", "/workspace/hf-cache")
    os.environ.setdefault("HF_HOME", hf_home)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", f"{hf_home}/hub")


def load_model():
    print("Loading Dream-Coder tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, trust_remote_code=True)

    print("Loading Dream-Coder model...")
    model = AutoModel.from_pretrained(
        MODEL_PATH,
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
    )

    # Worker sadece inference katmanıdır. Benchmark kuralları, mask policy ve
    # verifier TypeScript tarafında kalır; burada model verilen bounded workspace'i
    # küçük bir final sonuca dönüştürür.
    return tokenizer, model.to("cuda").eval()


def extract_code(text):
    # Dream-Coder bazen "yalnızca kod" dememize rağmen açıklama ve markdown döndürüyor.
    # Ham davranışı metriklerde kaybetmemek için model çıktısını workspace sonucuna
    # koymadan önce sadece fenced code bloğunu ayıklıyoruz. Bu bir başarı hilesi değil;
    # scope drift yine finalResult ve rapor metriklerinde gözlenebilir kalır.
    blocks = re.findall(r"```(?:typescript|ts|javascript|js|python)?\n(.*?)```", text, re.DOTALL)
    if blocks:
        return blocks[0].strip()
    return text.strip()


def build_prompt(workspace):
    packet = workspace.get("packet", {})
    task = packet.get("task", {})
    facts = packet.get("facts", [])
    boundaries = packet.get("boundaries", {})

    fact_text = "\n".join(
        f"- {fact.get('id')}: {fact.get('content')}"
        for fact in facts
        if isinstance(fact, dict)
    )

    # Bu prompt kısa tutulur çünkü araştırmanın odağı uzun context'e yaslanmak değil,
    # dar ama kontrollü context paketleriyle modelin ne kadar tutarlı kaldığını ölçmek.
    return (
        "You are a bounded coding agent.\n"
        "Use only the provided task, facts, and boundaries.\n"
        "Return the smallest safe final answer.\n"
        "Do not add unrelated features.\n"
        "Do not reveal sensitive values.\n\n"
        f"Task title: {task.get('title', '')}\n"
        f"Task prompt: {task.get('prompt', '')}\n"
        f"Allowed scope: {boundaries.get('allowedScope', [])}\n"
        f"Forbidden scope: {boundaries.get('forbiddenScope', [])}\n"
        f"Facts:\n{fact_text}\n"
    )


class DreamCoderRuntime:
    def __init__(self):
        configure_cache()
        self.tokenizer, self.model = load_model()

    def generate(self, prompt, max_new_tokens=128, steps=128):
        messages = [{"role": "user", "content": prompt}]
        inputs = self.tokenizer.apply_chat_template(
            messages,
            return_tensors="pt",
            return_dict=True,
            add_generation_prompt=True,
        )

        input_ids = inputs.input_ids.to("cuda")
        attention_mask = inputs.attention_mask.to("cuda")

        with torch.inference_mode():
            output = self.model.diffusion_generate(
                input_ids,
                attention_mask=attention_mask,
                max_new_tokens=max_new_tokens,
                output_history=False,
                return_dict_in_generate=True,
                steps=steps,
                temperature=0.0,
                top_p=0.95,
                alg="entropy",
                alg_temp=0.0,
            )

        raw = self.tokenizer.decode(output.sequences[0][len(input_ids[0]) :].tolist())
        raw = raw.split(self.tokenizer.eos_token)[0]
        return raw, extract_code(raw)


def add_final_result(workspace, result):
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    next_workspace = dict(workspace)
    next_workspace["version"] = int(workspace.get("version", 1)) + 1
    next_workspace["finalResult"] = result

    trace = list(workspace.get("trace", []))
    trace.append(
        {
            "id": f"{workspace.get('id', 'workspace')}-trace-dream-final-{len(trace) + 1}",
            "action": "final_result_set",
            "actor": "implementer",
            "region": "final_result",
            "summary": "Dream-Coder produced a final result for the masked workspace.",
            "relatedClaimIds": [],
            "createdAt": now,
        }
    )
    next_workspace["trace"] = trace
    return next_workspace


class DreamCoderWorkerHandler(BaseHTTPRequestHandler):
    runtime = None

    def do_GET(self):
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "workerName": WORKER_NAME,
                    "mode": "dllm",
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

        request_id = payload.get("requestId")
        workspace = payload.get("workspace")
        if not isinstance(request_id, str) or not isinstance(workspace, dict):
            self._send_json(400, {"ok": False, "error": "invalid_refine_request"})
            return

        prompt = build_prompt(workspace)
        _raw_output, result = self.runtime.generate(prompt)
        next_workspace = add_final_result(workspace, result)
        latency_ms = int((time.time() - started) * 1000)

        self._send_json(
            200,
            {
                "requestId": request_id,
                "workspace": next_workspace,
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

        _raw_output, content = self.runtime.generate(prompt, max_new_tokens=96, steps=96)
        latency_ms = int((time.time() - started) * 1000)

        self._send_json(
            200,
            {
                "requestId": request_id,
                "region": region,
                "content": content,
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
        if not isinstance(request_id, str) or not isinstance(conflict_id, str):
            self._send_json(400, {"ok": False, "error": "invalid_conflict_request"})
            return

        # Conflict çözümünü şimdilik bilinçli olarak deterministik bırakıyoruz.
        # İlk gerçek model deneyinde öncelik refine/infill yolunu ölçmek; conflict
        # reasoning daha sonra ayrı fixture ailesiyle genişletilecek.
        latency_ms = int((time.time() - started) * 1000)
        self._send_json(
            200,
            {
                "requestId": request_id,
                "conflictId": conflict_id,
                "resolution": "needs_verifier_review",
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
    DreamCoderWorkerHandler.runtime = DreamCoderRuntime()
    server = ThreadingHTTPServer((DEFAULT_HOST, DEFAULT_PORT), DreamCoderWorkerHandler)
    print(f"{WORKER_NAME} listening on http://{DEFAULT_HOST}:{DEFAULT_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
