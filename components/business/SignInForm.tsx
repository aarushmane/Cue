"use client";
// Email + password sign-in for store staff (Supabase Auth). On success the session is stored in cookies by
// @supabase/ssr and the page loads the manager app (or the page the employee was sent here from).
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import type { AuthError } from "@supabase/supabase-js";
import { getBrowserSupabase } from "@/lib/auth/browserClient";
import { MANAGER_HOME, safeNext, signInRequired } from "@/lib/auth/config";
import { Button, Card, controlClass, Field, H2, PageHeader } from "./ui";

const ERROR_ID = "sign-in-error";

function describe(error: AuthError): string {
  if (error.code === "invalid_credentials") return "That email and password don’t match a staff account. Check both and try again.";
  if (error.code === "email_not_confirmed") return "This email address hasn’t been confirmed yet. Open the link in your invitation email first.";
  if (error.status === 429 || error.code === "over_request_rate_limit") return "Too many sign-in attempts. Wait a minute, then try again.";
  if (error.name === "AuthRetryableFetchError" || !error.status) return "Couldn’t reach the sign-in service. Check your connection and try again.";
  return "Sign-in didn’t work. Try again.";
}

export function SignInForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  if (!signInRequired()) {
    return (
      <>
        <PageHeader title="Staff sign-in" />
        <Card aria-labelledby="no-sign-in-h" className="flex flex-col gap-3">
          <H2 id="no-sign-in-h">Sign-in isn’t needed in demo mode</H2>
          <p className="m-0 text-[15px] leading-[1.45]">This server has no Supabase project configured, so the manager app is open.</p>
          <Link href={MANAGER_HOME} className="sg-primary flex min-h-[52px] items-center justify-center rounded-full bg-indigo px-[22px] text-base font-bold text-white no-underline">
            Open the manager app
          </Link>
        </Card>
      </>
    );
  }

  const supabase = getBrowserSupabase();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!email || !password) {
      setError(!email ? "Enter your work email address." : "Enter your password.");
      (!email ? emailRef : passwordRef).current?.focus();
      return;
    }
    if (!supabase) return;
    setBusy(true);
    setError("");
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setBusy(false);
      setError(describe(authError));
      passwordRef.current?.select();
      return;
    }
    // Full page load so proxy.ts sees the new session cookies and the manager app starts with clean state.
    window.location.replace(safeNext(new URLSearchParams(window.location.search).get("next")));
  }

  const invalid = error ? true : undefined;
  return (
    <>
      <PageHeader title="Staff sign-in" sub="Sign in with your store staff account to review products and edit the floor plan." />
      <Card aria-labelledby="sign-in-h" className="flex flex-col gap-4">
        <H2 id="sign-in-h" className="sr-only">
          Sign in
        </H2>
        {!supabase ? (
          <p role="alert" className="m-0 rounded-[20px] border-2 border-gold bg-warn p-3.5 text-[15px] leading-[1.45] font-bold">
            Sign-in isn’t configured on this server: NEXT_PUBLIC_SUPABASE_ANON_KEY is missing. Ask whoever runs StoreGuide to set it.
          </p>
        ) : null}
        <form noValidate onSubmit={onSubmit} aria-labelledby="sign-in-h" className="flex flex-col gap-4">
          <Field label="Work email">
            <input
              ref={emailRef}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={invalid}
              aria-describedby={error ? ERROR_ID : undefined}
              className={controlClass}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <Field label="Password">
              <input
                ref={passwordRef}
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                aria-invalid={invalid}
                aria-describedby={error ? ERROR_ID : undefined}
                className={controlClass}
              />
            </Field>
            <button
              type="button"
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
              className="min-h-11 self-start border-0 bg-transparent px-1 text-[15px] font-bold text-indigo"
            >
              Show password
            </button>
          </div>

          {/* Always mounted so screen readers announce each new error. */}
          <p
            id={ERROR_ID}
            role="alert"
            className={error ? "m-0 rounded-[20px] border-2 border-gold bg-warn p-3.5 text-[15px] leading-[1.45] font-bold" : "sr-only-live"}
          >
            {error}
          </p>

          {/* Not `disabled` while busy: that would drop keyboard focus. onSubmit ignores repeat presses instead. */}
          <Button type="submit" disabled={!supabase} aria-disabled={busy || undefined}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </>
  );
}
