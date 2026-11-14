import type { Metadata } from "next";
import { SignInForm } from "@/components/business/SignInForm";

export const metadata: Metadata = { title: "Sign in · StoreGuide store manager" };

// Staff sign-in. BusinessShell renders this page without the manager nav. proxy.ts sends signed-out visitors here
// (with ?next=) and sends signed-in ones on to the manager app.
export default function SignInPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-lavender text-charcoal">
      <div aria-hidden="true" className="h-[max(16px,env(safe-area-inset-top))] flex-none" />
      <main className="flex flex-1 flex-col gap-[22px] px-5 pt-1 pb-7">
        <SignInForm />
      </main>
    </div>
  );
}
