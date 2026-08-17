"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ErrorPanel } from "@/components/ui/feedback";

export default function ReviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <ErrorPanel
        title="Couldn't load this document"
        description={
          error.digest
            ? `Something went wrong fetching it. Reference: ${error.digest}`
            : "Something went wrong fetching it."
        }
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={reset}>
              Try again
            </Button>
            <Link href="/documents">
              <Button size="sm" variant="ghost">
                Back to documents
              </Button>
            </Link>
          </div>
        }
      />
    </main>
  );
}
