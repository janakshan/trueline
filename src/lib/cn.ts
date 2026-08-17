/**
 * Joins class names, dropping falsy values.
 *
 * `clsx` + `tailwind-merge` are the usual reach here — ~8 KB for conditional
 * classes and conflict resolution. We don't have Tailwind class conflicts to
 * resolve (components own their classes; callers extend rather than override),
 * so this is the whole feature.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
