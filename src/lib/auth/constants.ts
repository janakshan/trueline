/**
 * Auth constants with zero imports.
 *
 * Exists because middleware runs on the edge runtime, which cannot load
 * `node:crypto`. Importing this name from session.ts pulled that module's
 * entire dependency graph — crypto, env, next/headers — into the edge bundle
 * and failed the build with `UnhandledSchemeError: node:crypto`.
 *
 * Anything imported by middleware must stay edge-safe. Keep this file free of
 * dependencies.
 */
export const SESSION_COOKIE = "trueline_session";
