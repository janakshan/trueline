import Link from "next/link";

/**
 * Root not-found. Without this, any unmatched URL falls through to Next's
 * unstyled default, which looks like a different site.
 *
 * Plain <a>-style link rather than the shared Button component: this renders
 * outside the (app) group, so it must not assume a session or app chrome.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <p className="text-2xs font-medium uppercase tracking-wider text-subtle">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-muted">
          That page doesn&apos;t exist. It may have moved, or the link may be wrong.
        </p>
        <Link
          href="/documents"
          className="mt-6 inline-flex h-10 items-center rounded-[var(--radius-control)] bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary-hover"
        >
          Back to documents
        </Link>
      </div>
    </main>
  );
}
