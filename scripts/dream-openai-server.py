import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModel, AutoTokenizer


MODEL_PATH = os.environ.get("DREAM_SNAPSHOT", "/tmp/hf-cache/models--Dream-org--Dream-Coder-v0-Instruct-7B/snapshots/")
MODEL_ID = os.environ.get("DREAM_MODEL_ID", "dream-coder-v0-instruct-7b")
HOST = os.environ.get("DREAM_HOST", "0.0.0.0")
PORT = int(os.environ.get("DREAM_PORT", "8002"))
MAX_NEW_TOKENS = int(os.environ.get("DREAM_MAX_NEW_TOKENS", "128"))
DEFAULT_STEPS = int(os.environ.get("DREAM_STEPS", str(MAX_NEW_TOKENS)))
DEFAULT_TEMPERATURE = float(os.environ.get("DREAM_TEMPERATURE", "0"))
DEFAULT_TOP_P = float(os.environ.get("DREAM_TOP_P", "0.95"))
LOCAL_FILES_ONLY = os.environ.get("DREAM_LOCAL_FILES_ONLY", "1") != "0"


def clamp_int(value, default, minimum, maximum):
    try:
        parsed = int(value)
    except Exception:
        return default

    return max(minimum, min(maximum, parsed))


def response(status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return status, body, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": str(len(body)),
    }


print(json.dumps({
    "status": "loading",
    "server": "dream-openai-compatible-server",
    "model": MODEL_PATH,
    "servedModel": MODEL_ID,
    "port": PORT,
    "cuda_available": torch.cuda.is_available(),
    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    "local_files_only": LOCAL_FILES_ONLY,
}, ensure_ascii=False), flush=True)

tokenizer = AutoTokenizer.from_pretrained(
    MODEL_PATH,
    trust_remote_code=True,
    local_files_only=LOCAL_FILES_ONLY,
)

model = AutoModel.from_pretrained(
    MODEL_PATH,
    trust_remote_code=True,
    torch_dtype=torch.float16,
    device_map="auto",
    local_files_only=LOCAL_FILES_ONLY,
)

model.eval()
MODEL_DEVICE = next(model.parameters()).device

print(json.dumps({
    "status": "ready",
    "server": "dream-openai-compatible-server",
    "modelClass": model.__class__.__name__,
    "hasDiffusionGenerate": hasattr(model, "diffusion_generate"),
    "device": str(MODEL_DEVICE),
    "memoryAllocatedGb": round(torch.cuda.memory_allocated() / 1024**3, 2) if torch.cuda.is_available() else 0,
    "memoryReservedGb": round(torch.cuda.memory_reserved() / 1024**3, 2) if torch.cuda.is_available() else 0,
}, ensure_ascii=False), flush=True)


def normalize_messages(messages):
    normalized = []

    for message in messages:
        if not isinstance(message, dict):
            continue

        role = str(message.get("role", "user") or "user")
        content = str(message.get("content", "") or "")

        if role not in {"system", "user", "assistant"}:
            role = "user"

        normalized.append({"role": role, "content": content})

    if not normalized:
        normalized.append({"role": "user", "content": "Return exactly one JSON object with decision needs_review."})

    return normalized


def add_json_contract_reminder(messages):
    contract = (
        "\n\nFinal output reminder:\n"
        "Return exactly one valid JSON object and nothing else.\n"
        "Do not use markdown fences.\n"
        "Do not write analysis prose.\n"
        "Required shape: {\"decision\":\"approve|needs_review|reject\",\"reasoning\":\"short reason\",\"confidence\":0.0}"
    )

    copied = [dict(message) for message in messages]

    for index in range(len(copied) - 1, -1, -1):
        if copied[index]["role"] == "user":
            copied[index]["content"] += contract
            return copied

    copied.append({"role": "user", "content": contract.strip()})
    return copied


def message_text(messages):
    normalized = add_json_contract_reminder(normalize_messages(messages))

    try:
        return tokenizer.apply_chat_template(
            normalized,
            tokenize=False,
            add_generation_prompt=True,
        )
    except Exception:
        parts = []

        for message in normalized:
            role = message.get("role", "user")
            content = message.get("content", "")
            parts.append(f"<|{role}|>\n{content}")

        parts.append("<|assistant|>\n")
        return "\n\n".join(parts)


def extract_sequence(outputs):
    if hasattr(outputs, "sequences"):
        seq = outputs.sequences
        return seq[0] if getattr(seq, "ndim", 1) > 1 else seq

    if isinstance(outputs, torch.Tensor):
        return outputs[0] if outputs.ndim > 1 else outputs

    if isinstance(outputs, (tuple, list)) and outputs:
        first = outputs[0]

        if isinstance(first, torch.Tensor):
            return first[0] if first.ndim > 1 else first

    raise RuntimeError(f"Unsupported generation output type: {type(outputs)}")


def first_balanced_json_object(text):
    source = str(text or "")

    for start in [index for index, char in enumerate(source) if char == "{"]:
        depth = 0
        in_string = False
        escaped = False

        for index in range(start, len(source)):
            char = source[index]

            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue

            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1

                if depth == 0:
                    candidate = source[start:index + 1]

                    try:
                        parsed = json.loads(candidate)
                    except Exception:
                        break

                    if isinstance(parsed, dict):
                        return candidate

    return None


def clean_model_text(text):
    stripped = str(text or "").strip()
    json_object = first_balanced_json_object(stripped)

    if json_object:
        return json_object

    return stripped


def generate_completion(prompt, max_tokens, steps, temperature, top_p):
    encoded = tokenizer(prompt, return_tensors="pt")
    input_ids = encoded["input_ids"].to(MODEL_DEVICE)
    attention_mask = encoded.get("attention_mask")

    if attention_mask is not None:
        attention_mask = attention_mask.to(MODEL_DEVICE)

    prompt_tokens = int(input_ids.shape[-1])

    with torch.inference_mode():
        if hasattr(model, "diffusion_generate"):
            try:
                outputs = model.diffusion_generate(
                    inputs=input_ids,
                    attention_mask=attention_mask,
                    max_new_tokens=max_tokens,
                    steps=steps,
                    temperature=temperature,
                    top_p=top_p,
                )
            except TypeError:
                outputs = model.diffusion_generate(
                    inputs=input_ids,
                    attention_mask=attention_mask,
                    max_new_tokens=max_tokens,
                    steps=steps,
                )
        else:
            outputs = model.generate(
                input_ids=input_ids,
                attention_mask=attention_mask,
                max_new_tokens=max_tokens,
                do_sample=temperature > 0,
                temperature=max(temperature, 1e-5),
                top_p=top_p,
            )

    sequence = extract_sequence(outputs).detach().cpu()
    generated = sequence[prompt_tokens:]
    completion_tokens = int(generated.shape[-1])
    text = tokenizer.decode(generated, skip_special_tokens=True).strip()

    return clean_model_text(text), {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            self.send_json(200, {"ok": True, "model": MODEL_ID})
            return

        if self.path == "/v1/models":
            self.send_json(200, {
                "object": "list",
                "data": [
                    {
                        "id": MODEL_ID,
                        "object": "model",
                        "created": int(time.time()),
                        "owned_by": "runpod",
                    }
                ],
            })
            return

        self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": "not_found"})
            return

        started = time.time()
        length = int(self.headers.get("Content-Length", "0"))

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            messages = payload.get("messages", [])

            max_tokens = clamp_int(payload.get("max_tokens", MAX_NEW_TOKENS), MAX_NEW_TOKENS, 8, 256)
            steps = clamp_int(payload.get("steps", DEFAULT_STEPS), DEFAULT_STEPS, 8, 256)
            temperature = float(payload.get("temperature", DEFAULT_TEMPERATURE))
            top_p = float(payload.get("top_p", DEFAULT_TOP_P))

            prompt = message_text(messages)
            text, usage = generate_completion(
                prompt=prompt,
                max_tokens=max_tokens,
                steps=steps,
                temperature=temperature,
                top_p=top_p,
            )

            self.send_json(200, {
                "id": f"chatcmpl-dream-{int(time.time())}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": payload.get("model", MODEL_ID),
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": usage,
                "timings": {
                    "latency_ms": round((time.time() - started) * 1000),
                },
            })

        except Exception as error:
            self.send_json(500, {
                "error": {
                    "message": str(error),
                    "type": error.__class__.__name__,
                }
            })

    def send_json(self, status, payload):
        status, body, headers = response(status, payload)
        self.send_response(status)

        for key, value in headers.items():
            self.send_header(key, value)

        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Dream OpenAI-compatible server listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
