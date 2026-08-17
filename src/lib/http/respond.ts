import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { AppError, isConnectionError } from "./errors";

/** Success bodies are always `{ data: ... }`, optionally with `{ meta: ... }`. */
export function ok<T>(
  data: T,
  init?: { status?: number; meta?: unknown; requestId?: string },
): Response {
  const body: Record<string, unknown> = { data };
  if (init?.meta !== undefined) body.meta = init.meta;

  return Response.json(body, {
    status: init?.status ?? 200,
    headers: init?.requestId ? { "x-request-id": init.requestId } : undefined,
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): Response {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;

  return Response.json({ error, requestId }, {
    status,
    headers: { "x-request-id": requestId },
  });
}

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/**
 * Wraps a route handler so that every failure — thrown AppError, Zod parse
 * failure, or an unexpected crash — becomes the same error envelope, and every
 * response carries a request id.
 *
 * Unexpected errors are logged in full server-side but returned to the client
 * as a bare INTERNAL_ERROR: stack traces and driver messages leak schema
 * details and are never safe to echo back.
 */
export function route<C>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    const requestId = randomUUID();

    try {
      const response = await handler(request, context);
      if (!response.headers.has("x-request-id")) {
        response.headers.set("x-request-id", requestId);
      }
      return response;
    } catch (err) {
      if (err instanceof AppError) {
        return errorResponse(
          err.status,
          err.code,
          err.message,
          requestId,
          err.details,
        );
      }

      if (err instanceof ZodError) {
        return errorResponse(
          400,
          "VALIDATION_ERROR",
          "Request validation failed.",
          requestId,
          err.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        );
      }

      // A database that is down is an availability problem, not a bug. 503
      // tells the client to retry and tells the operator where to look; a
      // generic 500 sends them hunting through application code.
      if (isConnectionError(err)) {
        console.error(`[${requestId}] Database unreachable`, err);
        return errorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "The database is unavailable. Please try again in a moment.",
          requestId,
        );
      }

      console.error(`[${requestId}] Unhandled error`, err);
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "An unexpected error occurred.",
        requestId,
      );
    }
  };
}
