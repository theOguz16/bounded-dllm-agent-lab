from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import time

import torch
from transformers import AutoModel, AutoTokenizer


MODEL_PATH = os.environ.get("DREAM_CODER_MODEL", "Dream-org/Dream-Coder-v0-Instruct-7B")
WORKER_NAME = "dream-coder-dllm-worker"
WORKER_VERSION = "0.3.0"
DEFAULT_HOST = os.environ.get("DLLM_WORKER_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("DLLM_WORKER_PORT", "8765"))


def configure_cache():
    """
    Model dosyaları büyük olduğu için cache'i /workspace altında tutuyoruz.
    RunPod pod stop edildiğinde /workspace kalırsa aynı modeli tekrar indirmeyiz.
    """
    hf_home = os.environ.get("HF_HOME", "/workspace/hf-cache")
    os.environ.setdefault("HF_HOME", hf_home)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", f"{hf_home}/hub")


def load_model():
    print("Loading Dream-Coder tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, trust_remote_code=True)

    print("Loading Dream-Coder model...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    model = AutoModel.from_pretrained(
        MODEL_PATH,
        torch_dtype=dtype,
        trust_remote_code=True,
        low_cpu_mem_usage=True,
    )

    return tokenizer, model.to(device).eval(), device


def extract_code(text):
    """
    Dream-Coder bazen "yalnızca kod/JSON" dememize rağmen açıklama ve markdown
    döndürebilir. Ham davranışı tamamen saklamıyoruz ama JSON/code bloğu varsa
    çalışma sonucuna temiz içerik taşıyoruz.
    """
    blocks = re.findall(
        r"```(?:json|typescript|ts|javascript|js|python)?\n(.*?)```",
        text,
        re.DOTALL,
    )
    if blocks:
        return blocks[0].strip()

    return text.strip()

def extract_first_json_object(text):
    content = str(text).strip()

    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", content, re.IGNORECASE)
    if fenced:
        content = fenced.group(1).strip()

    start = -1
    depth = 0
    in_string = False
    escaped = False

    for index, char in enumerate(content):
        if start == -1:
            if char == "{":
                start = index
                depth = 1
            continue

        if escaped:
            escaped = False
            continue

        if char == "\\":
            escaped = True
            continue

        if char == '"':
            in_string = not in_string
            continue

        if in_string:
            continue

        if char == "{":
            depth += 1
            continue

        if char == "}":
            depth -= 1
            if depth == 0:
                candidate = content[start : index + 1]
                try:
                    json.loads(candidate)
                    return candidate
                except json.JSONDecodeError:
                    return None

    return None


def needs_json_patch_contract(prompt, region):
    if region == "final_result":
        return True

    if "STRICT_OUTPUT_CONTRACT" in prompt:
        return True

    if "VALID_OUTPUT_SHAPES" in prompt:
        return True

    if '"kind": "file_edit"' in prompt:
        return True

    return False


def build_json_repair_prompt(original_prompt, raw_output):
    return "\n".join(
        [
            "You must convert the previous model answer into exactly one valid JSON object.",
            "The first non-whitespace character must be {.",
            "The last non-whitespace character must be }.",
            "Do not write markdown.",
            "Do not write explanations.",
            "Do not use code fences.",
            "",
            "Valid output shapes:",
            json.dumps(
                {
                    "file_edit": {
                        "kind": "file_edit",
                        "changes": [
                            {
                                "file": "relative/path/to/file",
                                "search": "exact existing text block from the provided file content",
                                "replace": "replacement text block",
                            }
                        ],
                    },
                    "refusal": {
                        "kind": "refusal",
                        "reason": "short reason",
                    },
                },
                ensure_ascii=False,
                indent=2,
            ),
            "",
            "Original task packet and file context:",
            original_prompt[:12000],
            "",
            "Previous non-JSON answer:",
            str(raw_output)[:4000],
            "",
            "Return JSON only now.",
        ]
    )


def coerce_json_patch_output(runtime, prompt, raw_content):
    first_json = extract_first_json_object(raw_content)

    if first_json:
        return first_json

    repair_prompt = build_json_repair_prompt(prompt, raw_content)
    _repair_raw, repair_content = runtime.generate(
        repair_prompt,
        max_new_tokens=512,
        steps=256,
    )

    repaired_json = extract_first_json_object(repair_content)

    if repaired_json:
        return repaired_json

    return raw_content

def build_prompt(workspace):
    """
    Canonical workspace prompt builder.

    Eski sürüm workspace.packet okuyordu.
    Yeni runtime'da modelin görmesi gereken alanlar şunlar:
    - workspace.task
    - workspace.scope
    - workspace.authority
    - workspace.policy
    - workspace.repoFacts
    - workspace.patchIntent
    - workspace.roleViews
    """
    task = workspace.get("task", "")
    scope = workspace.get("scope", {})
    authority = workspace.get("authority", {})
    policy = workspace.get("policy", {})
    repo_facts = workspace.get("repoFacts", {})
    patch_intent = workspace.get("patchIntent", {})
    role_views = workspace.get("roleViews", [])

    prompt_payload = {
        "instruction": (
            "You are a bounded dLLM workspace refinement worker. "
            "Use only the canonical workspace fields provided below. "
            "Return the smallest safe final answer. "
            "Do not invent missing authority. "
            "Do not reveal raw sensitive values. "
            "Prefer current/correction authority over stale facts. "
            "If the workspace lacks enough authority, return insufficient_context."
        ),
        "output_contract": {
            "finalResult": "string",
            "reason": "short reason",
            "usedEvidenceIds": ["evidence ids or workspace field ids"],
        },
        "workspace": {
            "task": task,
            "scope": compact_json(scope),
            "authority": compact_json(authority),
            "policy": compact_json(policy),
            "repoFacts": compact_json(repo_facts),
            "patchIntent": compact_json(patch_intent),
            "roleViewsSummary": summarize_role_views(role_views),
        },
    }

    return json.dumps(prompt_payload, ensure_ascii=False, indent=2)


def summarize_role_views(role_views):
    if not isinstance(role_views, list):
        return []

    summary = []

    for item in role_views[:8]:
        if not isinstance(item, dict):
            continue

        summary.append(
            {
                "role": item.get("role"),
                "sufficiency": item.get("sufficiency"),
                "includedRegions": item.get("includedRegions"),
                "excludedRegions": item.get("excludedRegions"),
                "estimatedTokens": item.get("estimatedTokens"),
                "budgetTokens": item.get("budgetTokens"),
            }
        )

    return summary


def compact_json(value, max_chars=4000):
    """
    Worker prompt'unu patlatmamak için büyük alanları string olarak kompaktlaştırır.
    Model hala canonical alanları görür ama devasa workspace dump yememiş olur.
    """
    text = json.dumps(value, ensure_ascii=False, indent=2)
    if len(text) <= max_chars:
        return value

    return {
        "truncated": True,
        "preview": text[:max_chars],
        "originalCharLength": len(text),
    }


def select_grounding_fact(workspace, generated_result):
    """
    Canonical workspace'ten güvenli grounding seçer.

    Öncelik:
    1. authority.facts
    2. repoFacts.evidenceFacts içinde correction/current
    3. sensitive pattern için güvenli özet
    4. stale fact sadece düşük güvenli fallback olarak kalır
    """
    candidates = collect_grounding_candidates(workspace)

    if not candidates:
        return None

    generated_lower = generated_result.lower()

    for candidate in candidates:
        content = str(candidate.get("content", ""))
        if content and content.lower() in generated_lower:
            return candidate

    priority = {
        "correction": 0,
        "current": 1,
        "authority": 1,
        "sensitive": 2,
        "uncertain": 3,
        "stale": 4,
    }

    candidates.sort(
        key=lambda item: (
            priority.get(item.get("kind"), 9),
            -float(item.get("confidence", 0.5)),
            str(item.get("id", "")),
        )
    )

    return candidates[0]


def collect_grounding_candidates(workspace):
    candidates = []

    authority = workspace.get("authority", {})
    repo_facts = workspace.get("repoFacts", {})
    policy = workspace.get("policy", {})

    authority_facts = authority.get("facts", [])
    if isinstance(authority_facts, list):
        for index, fact in enumerate(authority_facts):
            if not isinstance(fact, str) or not fact.strip():
                continue

            candidates.append(
                {
                    "id": f"authority-fact-{index + 1}",
                    "kind": "authority",
                    "content": fact.strip(),
                    "evidenceId": f"workspace-authority-{index + 1}",
                    "confidence": 0.9,
                }
            )

    evidence_facts = repo_facts.get("evidenceFacts", [])
    if isinstance(evidence_facts, list):
        for index, fact in enumerate(evidence_facts):
            if not isinstance(fact, dict):
                continue

            content = str(fact.get("content", "")).strip()
            if not content:
                continue

            candidates.append(
                {
                    "id": str(fact.get("id", f"evidence-fact-{index + 1}")),
                    "kind": str(fact.get("kind", "current")),
                    "content": content,
                    "evidenceId": str(
                        fact.get("evidenceId", f"workspace-evidence-{index + 1}")
                    ),
                    "confidence": float(fact.get("confidence", 0.75)),
                }
            )

    policy_sensitive = policy.get("sensitivePatterns", [])
    repo_sensitive = repo_facts.get("sensitivePatterns", [])
    sensitive_patterns = []

    if isinstance(policy_sensitive, list):
        sensitive_patterns.extend(policy_sensitive)

    if isinstance(repo_sensitive, list):
        sensitive_patterns.extend(repo_sensitive)

    for index, pattern in enumerate(sensitive_patterns):
        if not isinstance(pattern, str) or not pattern.strip():
            continue

        candidates.append(
            {
                "id": f"sensitive-pattern-{index + 1}",
                "kind": "sensitive",
                "content": safe_sensitive_content(pattern),
                "evidenceId": f"workspace-sensitive-pattern-{index + 1}",
                "confidence": 0.7,
            }
        )

    stale_facts = repo_facts.get("staleFacts", [])
    if isinstance(stale_facts, list):
        for index, stale in enumerate(stale_facts):
            if not isinstance(stale, str) or not stale.strip():
                continue

            candidates.append(
                {
                    "id": f"stale-fact-{index + 1}",
                    "kind": "stale",
                    "content": stale.strip(),
                    "evidenceId": f"workspace-stale-fact-{index + 1}",
                    "confidence": 0.35,
                }
            )

    return candidates


def requires_insufficient_context(workspace):
    authority = workspace.get("authority", {})
    repo_facts = workspace.get("repoFacts", {})

    missing_rules = authority.get("missingRules", [])
    authority_facts = authority.get("facts", [])
    evidence_facts = repo_facts.get("evidenceFacts", [])

    has_missing_rules = isinstance(missing_rules, list) and len(missing_rules) > 0
    has_authority_facts = isinstance(authority_facts, list) and len(authority_facts) > 0

    has_current_evidence = False
    if isinstance(evidence_facts, list):
        has_current_evidence = any(
            isinstance(fact, dict) and fact.get("kind") in ("current", "correction")
            for fact in evidence_facts
        )

    return has_missing_rules and not has_authority_facts and not has_current_evidence


def apply_agentic_workspace_protocol(workspace, generated_result):
    """
    Canonical workspace output writer.

    Eski alanları yazmıyoruz:
    - boundaryDecision
    - verifier_feedback
    - actor: implementer
    - workspace.packet

    Yeni canonical alanlar:
    - finalResult
    - verifierResults
    - trace
    """
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    selected_fact = select_grounding_fact(workspace, generated_result)
    should_refuse = requires_insufficient_context(workspace)

    final_summary = resolve_final_summary(
        generated_result=generated_result,
        selected_fact=selected_fact,
        should_refuse=should_refuse,
    )

    verifier_decision = resolve_verifier_decision(
        selected_fact=selected_fact,
        should_refuse=should_refuse,
    )

    verifier_status = "pass" if verifier_decision == "approve" else "warn"
    failed_regions = [] if verifier_decision == "approve" else ["final_result"]

    evidence_ids = []
    if selected_fact and selected_fact.get("evidenceId"):
        evidence_ids.append(str(selected_fact.get("evidenceId")))

    next_workspace = dict(workspace)
    next_workspace["revision"] = int(workspace.get("revision", 1)) + 1
    next_workspace["updatedAt"] = now
    next_workspace["finalResult"] = {
        "summary": final_summary,
        "createdBy": "coder",
        "createdAt": now,
    }

    verifier_result = {
        "id": f"{workspace.get('id', 'workspace')}-verifier-dream-coder",
        "status": verifier_status,
        "decision": verifier_decision,
        "checkName": "dream_coder_canonical_grounding",
        "summary": resolve_verifier_summary(
            selected_fact=selected_fact,
            should_refuse=should_refuse,
            verifier_decision=verifier_decision,
        ),
        "findings": [],
        "checkedFiles": read_changed_files(workspace),
        "evidenceIds": evidence_ids,
        "failedRegions": failed_regions,
        "createdBy": "verifier",
        "createdAt": now,
    }

    existing_verifier_results = workspace.get("verifierResults", [])
    if not isinstance(existing_verifier_results, list):
        existing_verifier_results = []

    next_workspace["verifierResults"] = existing_verifier_results + [verifier_result]
    next_workspace["trace"] = append_trace(
        workspace=workspace,
        final_summary=final_summary,
        verifier_decision=verifier_decision,
        created_at=now,
    )

    return next_workspace


def resolve_final_summary(generated_result, selected_fact, should_refuse):
    if should_refuse:
        return "insufficient_context"

    if selected_fact is None:
        cleaned = generated_result.strip()
        return cleaned if cleaned else "insufficient_context"

    kind = selected_fact.get("kind")
    content = str(selected_fact.get("content", "")).strip()

    if kind == "sensitive":
        return safe_sensitive_content(content)

    if kind == "stale":
        """
        Stale fact tek başına merge-safe final sayılmaz.
        Bu durumda output'u doğrudan approve etmeyip remask/verifier tarafına
        problem sinyali bırakıyoruz.
        """
        return content if content else "insufficient_context"

    return content if content else "insufficient_context"


def resolve_verifier_decision(selected_fact, should_refuse):
    if should_refuse:
        return "remask_required"

    if selected_fact is None:
        return "remask_required"

    if selected_fact.get("kind") == "stale":
        return "remask_required"

    return "approve"


def resolve_verifier_summary(selected_fact, should_refuse, verifier_decision):
    if should_refuse:
        return "Dream-Coder refused to invent missing authority from the bounded workspace."

    if selected_fact is None:
        return "Dream-Coder produced output without a grounding fact; second-pass review is required."

    if selected_fact.get("kind") == "stale":
        return "Dream-Coder only found stale grounding; local remask and second-pass verifier are required."

    return (
        f"Dream-Coder grounded final result in {selected_fact.get('id')} "
        f"with decision {verifier_decision}."
    )


def append_trace(workspace, final_summary, verifier_decision, created_at):
    trace = workspace.get("trace", [])
    if not isinstance(trace, list):
        trace = []

    workspace_id = workspace.get("id", "workspace")
    base_index = len(trace) + 1

    trace.extend(
        [
            {
                "id": f"{workspace_id}-trace-dream-refine-{base_index}",
                "action": "worker_refine_completed",
                "actor": "coder",
                "region": "final_result",
                "summary": f"Dream-Coder wrote finalResult: {final_summary[:120]}",
                "createdAt": created_at,
            },
            {
                "id": f"{workspace_id}-trace-dream-verifier-{base_index + 1}",
                "action": "verifier_result_added",
                "actor": "verifier",
                "region": "verifier_result",
                "summary": f"Dream-Coder worker verifier decision: {verifier_decision}",
                "createdAt": created_at,
            },
        ]
    )

    return trace


def read_changed_files(workspace):
    scope = workspace.get("scope", {})
    if not isinstance(scope, dict):
        return []

    changed_files = scope.get("changedFiles", [])
    if not isinstance(changed_files, list):
        return []

    return [str(item) for item in changed_files]


def safe_sensitive_content(content):
    """
    Sensitive benchmark'lerde content bazen "Raw value:" ile gerçek sırrı taşıyordu.
    Worker raw secret'ı output'a kopyalamaz.
    """
    text = str(content)

    if "Raw value:" in text:
        return text.split("Raw value:", 1)[0].strip()

    if " raw value:" in text.lower():
        lower = text.lower()
        index = lower.find(" raw value:")
        return text[:index].strip()

    return text.strip()


def format_scope(scope_regions):
    if not isinstance(scope_regions, list) or not scope_regions:
        return "- none"

    lines = []
    for region in scope_regions:
        if not isinstance(region, dict):
            lines.append(f"- {region}")
            continue

        label = region.get("label", "")
        path = region.get("path", "")
        reason = region.get("reason", "")
        lines.append(f"- {label} {path} {reason}".strip())

    return "\n".join(lines)


class DreamCoderRuntime:
    def __init__(self):
        configure_cache()
        self.tokenizer, self.model, self.device = load_model()

    def generate(self, prompt, max_new_tokens=128, steps=128):
        messages = [{"role": "user", "content": prompt}]
        inputs = self.tokenizer.apply_chat_template(
            messages,
            return_tensors="pt",
            return_dict=True,
            add_generation_prompt=True,
        )

        input_ids = inputs.input_ids.to(self.device)
        attention_mask = inputs.attention_mask.to(self.device)

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

        raw = self.tokenizer.decode(
            output.sequences[0][len(input_ids[0]) :].tolist()
        )

        if self.tokenizer.eos_token:
            raw = raw.split(self.tokenizer.eos_token)[0]

        return raw, extract_code(raw)


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
                    "modelName": MODEL_PATH,
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
        next_workspace = apply_agentic_workspace_protocol(workspace, result)
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

        if (
            not isinstance(request_id, str)
            or not isinstance(region, str)
            or not isinstance(prompt, str)
        ):
            self._send_json(400, {"ok": False, "error": "invalid_infill_request"})
            return

        json_patch_contract = needs_json_patch_contract(prompt, region)

        max_new_tokens = 512 if json_patch_contract else 128
        steps = 256 if json_patch_contract else 128

        _raw_output, content = self.runtime.generate(
            prompt,
            max_new_tokens=max_new_tokens,
            steps=steps,
        )

        if json_patch_contract:
            content = coerce_json_patch_output(self.runtime, prompt, content)

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
            started = time.time()
            payload = self._read_json()

            if payload is None:
                self._send_json(400, {"ok": False, "error": "invalid_json"})
                return

            request_id = payload.get("requestId")
            region = payload.get("region")
            prompt = payload.get("prompt")

            if (
                not isinstance(request_id, str)
                or not isinstance(region, str)
                or not isinstance(prompt, str)
            ):
                self._send_json(400, {"ok": False, "error": "invalid_infill_request"})
                return

            _raw_output, content = self.runtime.generate(
                prompt,
                max_new_tokens=96,
                steps=96,
            )

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
        workspace = payload.get("workspace")

        if (
            not isinstance(request_id, str)
            or not isinstance(conflict_id, str)
            or not isinstance(workspace, dict)
        ):
            self._send_json(400, {"ok": False, "error": "invalid_conflict_request"})
            return

        resolution = resolve_conflict(workspace, conflict_id)
        latency_ms = int((time.time() - started) * 1000)

        self._send_json(
            200,
            {
                "requestId": request_id,
                "conflictId": conflict_id,
                "resolution": resolution,
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
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def resolve_conflict(workspace, conflict_id):
    repo_facts = workspace.get("repoFacts", {})
    evidence_facts = repo_facts.get("evidenceFacts", [])

    has_current_or_correction = False
    has_stale = False

    if isinstance(evidence_facts, list):
        for fact in evidence_facts:
            if not isinstance(fact, dict):
                continue

            if fact.get("kind") in ("current", "correction"):
                has_current_or_correction = True

            if fact.get("kind") == "stale":
                has_stale = True

    if has_current_or_correction and has_stale:
        return (
            "Prefer current/correction evidence over stale evidence; "
            "remask final_result and require second-pass verifier."
        )

    if has_current_or_correction:
        return "Prefer current/correction evidence and allow verifier to approve after bounded remask."

    return "needs_verifier_review"


def main():
    DreamCoderWorkerHandler.runtime = DreamCoderRuntime()
    server = ThreadingHTTPServer((DEFAULT_HOST, DEFAULT_PORT), DreamCoderWorkerHandler)
    print(f"{WORKER_NAME} listening on http://{DEFAULT_HOST}:{DEFAULT_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()