import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/auth/session";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage() {
  if (await getSessionUserId()) redirect("/documents");
  return (
    <main className="flex min-h-screen justify-center px-4 pt-12 sm:items-center sm:pt-0">
      <SignInForm />
    </main>
  );
}
