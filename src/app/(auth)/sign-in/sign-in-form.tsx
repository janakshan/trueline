"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorPanel } from "@/components/ui/feedback";

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function signIn(withEmail: string, withPassword: string) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: withEmail, password: withPassword }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not sign in. Please try again.");
        setPending(false);
        return;
      }
      // Keep `pending` true through the navigation so the button never flashes
      // back to its resting state before the redirect lands.
      router.push("/documents");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  async function demoSignIn() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/demo", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Demo login is unavailable right now.");
        setPending(false);
        return;
      }
      router.push("/documents");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <div className="w-full max-w-[380px]">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Trueline</h1>
        <p className="mt-1.5 text-sm text-muted">
          Extract structured data from invoices and receipts.
        </p>
      </div>

      {/*
        The single most important element on this page. Someone opening this
        from a proposal will not sign up, guess a password, or email for
        credentials — they will close the tab.

        It posts to a dedicated endpoint rather than sending a password: any
        credential this button could send would be in the JS bundle, and so
        public regardless of length.
      */}
      <Button
        variant="primary"
        className="w-full"
        loading={pending}
        onClick={() => void demoSignIn()}
      >
        Try the demo
      </Button>

      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-2xs uppercase tracking-wider text-subtle">or sign in</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {error && (
        <div className="mb-4">
          <ErrorPanel title={error} />
        </div>
      )}

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void signIn(email, password);
        }}
      >
        <label className="block">
          <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wider text-muted">
            Email
          </span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-base sm:h-10 sm:text-sm"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wider text-muted">
            Password
          </span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-base sm:h-10 sm:text-sm"
          />
        </label>

        <Button type="submit" variant="secondary" className="w-full" loading={pending}>
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-xs text-subtle">
        Use <span className="font-medium">Try the demo</span> for instant access — no
        signup, no credentials needed.
      </p>
    </div>
  );
}
