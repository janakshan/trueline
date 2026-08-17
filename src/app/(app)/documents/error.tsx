"use client";

import { Button } from "@/components/ui/button";
import { ErrorPanel } from "@/components/ui/feedback";

export default function DocumentsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="text-xl font-semibold tracking-tight">Documents</h1>
      <div className="mt-5">
        <ErrorPanel
          title="Couldn't load your documents"
          description={
            error.digest
              ? `Something went wrong reaching the database. Reference: ${error.digest}`
              : "Something went wrong reaching the database."
          }
          action={<Button size="sm" onClick={reset}>Try again</Button>}
        />
      </div>
    </main>
  );
}
