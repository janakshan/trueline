/**
 * Every error this API returns has the same shape:
 *
 *   { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": ... },
 *     "requestId": "..." }
 *
 * `code` is a stable machine-readable string the client switches on; `message`
 * is for humans and may change freely. Clients must never parse `message`.
 */

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError("VALIDATION_ERROR", message, details);

export const unauthorized = (message = "Authentication required."): AppError =>
  new AppError("UNAUTHORIZED", message);

export const notFound = (message = "Resource not found."): AppError =>
  new AppError("NOT_FOUND", message);

export const payloadTooLarge = (message: string, details?: unknown): AppError =>
  new AppError("PAYLOAD_TOO_LARGE", message, details);

export const unsupportedMediaType = (
  message: string,
  details?: unknown,
): AppError => new AppError("UNSUPPORTED_MEDIA_TYPE", message, details);

/**
 * Postgres connection failures, walked out of the driver's wrapped cause chain.
 *
 * Drizzle wraps the pg error, which itself wraps an AggregateError, so the
 * useful `code` sits two or three levels down from what reaches the handler.
 * Without this, a stopped database is indistinguishable from a genuine bug: it
 * surfaces as INTERNAL_ERROR and the user is told their sign-in failed, when
 * their credentials were never checked.
 */
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
]);

export function isConnectionError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;

  // Bounded walk: a self-referential cause chain would otherwise hang here.
  for (let depth = 0; current && depth < 10; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);

    const node = current as { code?: unknown; errors?: unknown[]; cause?: unknown };
    if (typeof node.code === "string" && CONNECTION_CODES.has(node.code)) return true;
    if (Array.isArray(node.errors) && node.errors.some((e) => isConnectionError(e))) return true;

    current = node.cause;
  }
  return false;
}
