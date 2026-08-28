export const PRODUCTION_MODEL_FAILURE_CODES = [
  "AUTH_FAILURE",
  "RATE_LIMITED",
  "REQUEST_REJECTED",
  "STRUCTURED_OUTPUT_UNSUPPORTED",
  "TIMEOUT",
  "TRANSPORT_FAILURE",
  "MODEL_RESPONSE_INVALID"
] as const;

export type ProductionModelFailureCode =
  (typeof PRODUCTION_MODEL_FAILURE_CODES)[number];

const PRODUCTION_MODEL_FAILURE_CODE_SET = new Set<string>(
  PRODUCTION_MODEL_FAILURE_CODES
);

export class ProductionModelError extends Error {
  constructor(readonly code: ProductionModelFailureCode) {
    super(code);
    this.name = "ProductionModelError";
  }
}

export function isProductionModelFailureCode(
  value: unknown
): value is ProductionModelFailureCode {
  return typeof value === "string" && PRODUCTION_MODEL_FAILURE_CODE_SET.has(value);
}

export function normalizeProductionModelFailureCode(
  value: unknown
): ProductionModelFailureCode | null {
  if (isProductionModelFailureCode(value)) return value;
  if (typeof value !== "string") return null;

  // Compatibility for legacy adapter-like wrappers that still carry a provider
  // prefix. The execution core never needs to know the provider name: only the
  // semantic suffix is considered here. New adapters should emit the common
  // taxonomy directly instead of relying on this compatibility path.
  if (/(?:^|_)(?:AUTH_FAILED|AUTHENTICATION_FAILED|PERMISSION_DENIED|CREDENTIAL_MISSING)$/.test(value)) {
    return "AUTH_FAILURE";
  }
  if (/(?:^|_)RATE_LIMITED$/.test(value)) return "RATE_LIMITED";
  if (/(?:^|_)JSON_SCHEMA_UNSUPPORTED$/.test(value)) {
    return "STRUCTURED_OUTPUT_UNSUPPORTED";
  }
  if (/(?:^|_)(?:COLD_START_TIMEOUT|REQUEST_TIMEOUT|PROXY_TIMEOUT)$/.test(value)) {
    return "TIMEOUT";
  }
  if (/(?:^|_)(?:ENDPOINT_UNAVAILABLE|UPSTREAM_SERVER_ERROR|PROXY_BAD_GATEWAY|PROXY_UNAVAILABLE|NETWORK_ERROR|INTERNAL_ERROR)$/.test(value)) {
    return "TRANSPORT_FAILURE";
  }
  if (/(?:^|_)(?:RESPONSE_EMPTY|RESPONSE_MULTIPLE_CHOICES|RESPONSE_TRUNCATED|RESPONSE_NOT_JSON|RESPONSE_SCHEMA_INVALID|RESPONSE_TOO_LARGE|USAGE_INVALID|RESPONSE_INVALID)$/.test(value)) {
    return "MODEL_RESPONSE_INVALID";
  }
  if (/(?:^|_)(?:ENDPOINT_MISSING|MODEL_MISSING|BASE_URL_INVALID|ENDPOINT_ID_INVALID|BASE_URL_NOT_ALLOWED|CREDENTIAL_BEARING_URL|ENDPOINT_NOT_FOUND|MODEL_NOT_FOUND|REQUEST_REJECTED)$/.test(value)) {
    return "REQUEST_REJECTED";
  }
  return null;
}

export function createProviderAbortError(): Error {
  const error = new Error("ABORTED");
  error.name = "AbortError";
  return error;
}
