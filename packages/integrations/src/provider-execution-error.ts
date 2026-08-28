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

export function createProviderAbortError(): Error {
  const error = new Error("ABORTED");
  error.name = "AbortError";
  return error;
}
