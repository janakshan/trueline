import { notFound } from "next/navigation";
import { requireUserId } from "@/lib/auth/session";
import { getDocument } from "@/lib/documents/queries";
import { ReviewView } from "./review-view";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await requireUserId();
  const { id } = await params;

  // A malformed id is a 404 rather than a crash — the route is user-typeable.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const detail = await getDocument(userId, id);
  if (!detail) notFound();

  return <ReviewView initial={detail} />;
}
