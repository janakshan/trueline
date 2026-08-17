"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={async () => {
        setPending(true);
        await fetch("/api/auth/sign-out", { method: "POST" });
        router.push("/sign-in");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
