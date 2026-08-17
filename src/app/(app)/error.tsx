"use client";

import { Button } from "@/components/ui/button";
import { ErrorPanel } from "@/components/ui/feedback";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <ErrorPanel
        title="Something went wrong"
        description={
          error.digest
            ? `This page could not be loaded. Reference: ${error.digest}`
            : "This page could not be loaded."
        }
        action={
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
        }
      />
    </main>
  );
}
