import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/auth/session";

export default async function RootPage() {
  redirect((await getSessionUserId()) ? "/documents" : "/sign-in");
}
