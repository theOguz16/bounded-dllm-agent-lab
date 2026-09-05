# Container Validation Runner Security Review Draft

Status: **review required before merge**

## Boundary

Phase X.5 validation commands execute through Docker. The host execution verifier remains available for producing earlier Phase V evidence, but X.5 never falls back to it. An unavailable daemon or missing image returns an explicit infrastructure failure and follows the existing rollback path.

The runner uses the pinned image:

`node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`

Automatic image pulls are disabled with `--pull never`.

## Mounts

- The copied task workspace is mounted at `/workspace` with `readonly`.
- `/workspace/.validation-output` is a separate writable tmpfs for reports. Its byte quota is enforced by the kernel while commands run; a full output filesystem returns `ENOSPC` before post-command manifest checks.
- No repository, registry, rollback bundle, user home, SSH directory, Docker socket, or other host path is mounted.
- The root filesystem is read-only. `/tmp` is a bounded `noexec,nosuid,nodev` tmpfs.

The nested writable output mount is intentionally excluded from the candidate manifest. The directory is created by X.5 and must not pre-exist in the candidate. Report bytes are untrusted scratch output and are discarded with the container rather than copied back to the host workspace.

## Runtime restrictions

- Network namespace: `--network none`
- Linux capabilities: `--cap-drop ALL`
- Privilege escalation: `no-new-privileges`
- Memory and swap: 512 MiB
- PID limit: 64
- CPU limit: 1 CPU
- Temporary storage: 64 MiB
- Container UID/GID: invoking runtime user, with `HOME=/nonexistent`

Only explicitly supplied non-secret environment keys are passed. Host environment, SSH agent variables, credentials, and home paths are not copied into the container.

## Container lifecycle cleanup

Each validation transaction receives a random `bounded-validation-<24 hex>` name and the fixed `com.bounded-dllm-agent-lab.validation-binding` label. The label value is the canonical transaction binding hash derived from the consumption key, authorization, X.4 apply receipt, and validation specification. The durable X.5 intent records the name, label key and value, pinned image digest, and transaction binding hash before `VALIDATION_STARTED` is written. User and model text never enters the name or label.

Each named `docker run` is enclosed by one `try/finally` lifecycle. Normal completion, timeout, output-buffer overflow, spawn failure, post-command callback failure, and unexpected exceptions all enter the same cleanup path. Cleanup lists only the exact recorded name, then verifies its full container ID, binding label, and configured image digest before mutation. A mismatch leaves the container untouched. A match is handled with `docker kill --signal KILL`, `docker rm --force`, a final exact-ID inspect, and an exact-name list check. A container that remains visible, or an unavailable runtime during the absence check, returns `validation_container_cleanup_recovery_required`; it cannot produce a passing validation result.

If the runtime process dies before its `finally` block, X.6 reads the same identity from the verified permanent X.5 intent and performs the exact cleanup sequence before repository rollback. Missing or altered identity evidence, a wrong-label same-name container, daemon failure, or removal failure produces a durable `recovery_failed` receipt and `RECOVERY_FAILED`; X.6 does not touch the repository in that attempt. X.6 never scans and deletes all containers sharing the prefix.

The Docker client is killed with `SIGKILL` at the command deadline. Acceptance tests verify timeout, output overflow, callback failure, cleanup command invocation, cleanup failure classification, daemon unavailability, wrong-label isolation, tampered identity evidence, `kill` success followed by `rm` failure, process `SIGKILL` immediately after container creation and during a validation command, replay safety, exact X.1 restoration, and the absence of real `bounded-validation-*` containers.

## Review questions

1. Confirm the pinned image and update process, including architecture-specific availability.
2. Confirm Docker Desktop host-directory sharing policy on supported platforms.
3. Confirm the 5 MiB default and 50 MiB hard maximum for the runtime validation-output tmpfs.
4. Decide whether production deployments require a stronger runtime such as rootless Docker, gVisor, or an equivalent sandbox.
5. Confirm that Docker daemon access is restricted to trusted runtime operators; daemon access itself is host-equivalent privilege on common installations.

Do not merge until these permissions, mount, image, and runtime assumptions receive security approval.
