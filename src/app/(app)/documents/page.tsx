import { requireUserId } from "@/lib/auth/session";
import { DOCUMENT_STATUSES, type DocumentStatus } from "@/lib/db/schema";
import { listDocuments } from "@/lib/documents/queries";
import { DocumentsView } from "./documents-view";

// Always fresh: the list is the polling surface while a batch extracts.
export const dynamic = "force-dynamic";

function parseStatus(value: string | undefined): DocumentStatus | undefined {
  return DOCUMENT_STATUSES.includes(value as DocumentStatus)
    ? (value as DocumentStatus)
    : undefined;
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const userId = await requireUserId();
  const status = parseStatus((await searchParams).status);
  const page = await listDocuments({ userId, status, limit: 50 });

  return (
    <DocumentsView
      items={page.items}
      counts={page.counts}
      activeFilter={status ?? "all"}
      nextCursor={page.nextCursor}
    />
  );
}
