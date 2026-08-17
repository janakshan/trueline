/**
 * Failure taxonomy for the extraction step, per architecture.md.
 *
 * The only distinction that matters operationally is retryable vs permanent:
 * automatically retrying a permanent failure is how a free-tier demo drains an
 * API budget overnight.
 */

export const EXTRACTION_ERROR_CODES = {
  /** Model output failed schema validation after a repair attempt. */
  SCHEMA_INVALID: { retryable: true, userMessage: "The model returned data that did not match the expected format." },
  /** Output hit max_tokens and was truncated mid-JSON. */
  OUTPUT_TRUNCATED: { retryable: true, userMessage: "The response was cut short before it finished." },
  /** Request or stream exceeded our time budget. */
  TIMEOUT: { retryable: true, userMessage: "Extraction took too long and was stopped." },
  /** 429 after the SDK's own retries. */
  RATE_LIMITED: { retryable: true, userMessage: "The extraction service is busy. Try again shortly." },
  /** 5xx / 529. */
  SERVICE_UNAVAILABLE: { retryable: true, userMessage: "The extraction service is temporarily unavailable." },
  /** Network failure before a response. */
  NETWORK_ERROR: { retryable: true, userMessage: "Could not reach the extraction service." },
  /** stop_reason: "refusal" — will never succeed on retry. */
  REFUSED: { retryable: false, userMessage: "The model declined to process this document." },
  /** 400: malformed request, unsupported file, too many pages. */
  INVALID_REQUEST: { retryable: false, userMessage: "This document could not be processed in its current form." },
  /** 401/403: our credentials. An operator problem, not the user's. */
  NOT_AUTHORISED: { retryable: false, userMessage: "The extraction service rejected our credentials." },
  /** Stored file missing or unreadable. */
  FILE_UNREADABLE: { retryable: false, userMessage: "The uploaded file could not be read." },
  /** Anything unclassified. */
  UNKNOWN: { retryable: true, userMessage: "An unexpected error occurred during extraction." },
} as const;

export type ExtractionErrorCode = keyof typeof EXTRACTION_ERROR_CODES;

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly detail: string | undefined;

  constructor(code: ExtractionErrorCode, detail?: string) {
    const meta = EXTRACTION_ERROR_CODES[code];
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ExtractionError";
    this.code = code;
    this.retryable = meta.retryable;
    this.userMessage = meta.userMessage;
    this.detail = detail;
  }
}

interface ApiErrorShape {
  status?: number;
  name?: string;
  message?: string;
}

/**
 * Maps an SDK/transport error onto the taxonomy. Anything unrecognised becomes
 * UNKNOWN (retryable) rather than being force-fitted into a specific code —
 * a wrong classification is worse than an honest one, because it drives whether
 * we spend money retrying.
 */
export function classifyError(err: unknown): ExtractionError {
  if (err instanceof ExtractionError) return err;

  const e = err as ApiErrorShape;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = typeof e?.message === "string" ? e.message : String(err);

  if (e?.name === "AbortError" || /abort|timed? ?out/i.test(message)) {
    return new ExtractionError("TIMEOUT", message);
  }

  if (status !== undefined) {
    if (status === 400) return new ExtractionError("INVALID_REQUEST", message);
    if (status === 401 || status === 403) return new ExtractionError("NOT_AUTHORISED", message);
    if (status === 429) return new ExtractionError("RATE_LIMITED", message);
    if (status >= 500) return new ExtractionError("SERVICE_UNAVAILABLE", message);
  }

  if (e?.name === "APIConnectionError" || /fetch failed|ECONN|ENOTFOUND|socket/i.test(message)) {
    return new ExtractionError("NETWORK_ERROR", message);
  }

  // The SDK throws a plain Error with no status when it cannot resolve
  // credentials at all. Without this it falls through to UNKNOWN (retryable)
  // and a misconfigured deploy burns every document's attempt budget against
  // a problem no retry can fix.
  if (
    /could not resolve authentication|authentication method|api[ _-]?key|invalid x-api-key|unauthori[sz]ed/i.test(
      message,
    )
  ) {
    return new ExtractionError("NOT_AUTHORISED", message);
  }

  return new ExtractionError("UNKNOWN", message);
}
