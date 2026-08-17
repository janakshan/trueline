import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";

export default function DocumentNotFound() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <EmptyState
        title="Document not found"
        description="It may have been deleted, or the link may be wrong."
        actions={
          <Link href="/documents">
            <Button variant="primary">Back to documents</Button>
          </Link>
        }
      />
    </main>
  );
}
