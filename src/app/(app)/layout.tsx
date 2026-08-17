import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionUserId } from "@/lib/auth/session";
import { Wordmark } from "@/components/ui/logo";
import { SignOutButton } from "./sign-out-button";

/**
 * Server-side session guard for the whole app group. Every page underneath is
 * a server component that assumes a user, so the check belongs here rather
 * than repeated in each page.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/sign-in");

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/documents" aria-label="Trueline — all documents">
            <Wordmark size="sm" />
          </Link>
          <SignOutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
