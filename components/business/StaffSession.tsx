"use client";
// Signed-in staff member for the manager shell: email + Sign out, and a notice when the account isn't staff for
// any store. Memory mode (no Supabase env) has no sign-in, and none of this renders.
import { useEffect, useState } from "react";
import { getBrowserSupabase } from "@/lib/auth/browserClient";
import { SIGN_IN_PATH, signInRequired } from "@/lib/auth/config";
import { Card, H2 } from "./ui";

export type StaffSessionState =
  | { mode: "memory" }
  /** staff: null while checking (or if the check failed), true/false once store_staff has answered. */
  | { mode: "supabase"; email: string | null; userId: string | null; staff: boolean | null };

export function useStaffSession(): StaffSessionState {
  // signInRequired() reads an inlined NEXT_PUBLIC_ value, so server and client render the same initial state.
  const [state, setState] = useState<StaffSessionState>(() =>
    signInRequired() ? { mode: "supabase", email: null, userId: null, staff: null } : { mode: "memory" },
  );
  const userId = state.mode === "supabase" ? state.userId : null;

  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) return;
    // Fires INITIAL_SESSION right away, then on sign-out (here or in another tab) and token refreshes.
    // The email shown comes from the cookie session; anything that matters is verified on the server.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        // Signed out elsewhere, or the refresh token was revoked: leave the manager app.
        window.location.replace(SIGN_IN_PATH);
        return;
      }
      setState((s) =>
        s.mode === "supabase" && s.userId === session.user.id
          ? s
          : { mode: "supabase", email: session.user.email ?? null, userId: session.user.id, staff: null },
      );
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // Is this account staff for any store? RLS ("staff read own staff rows") lets a user read only their own rows.
  // Kept out of the auth callback: Supabase calls made inside onAuthStateChange can deadlock.
  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase || !userId) return;
    let live = true;
    supabase
      .from("store_staff")
      .select("store_id", { count: "exact", head: true })
      .eq("user_id", userId)
      .then(({ count, error }) => {
        if (live) setState((s) => (s.mode === "supabase" && s.userId === userId ? { ...s, staff: error ? null : (count ?? 0) > 0 } : s));
      });
    return () => {
      live = false;
    };
  }, [userId]);

  return state;
}

export async function signOut() {
  // "local" ends this browser's session only, not the employee's sessions on their other devices.
  await getBrowserSupabase()?.auth.signOut({ scope: "local" });
  // Full page load: drops every bit of in-memory manager state (unsaved drafts, open sheets) on a shared device.
  window.location.replace(SIGN_IN_PATH);
}

export function SessionBar({ email }: { email: string | null }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-none items-center gap-3 px-5 pb-1">
      <p className="m-0 min-w-0 flex-1 truncate text-sm text-muted">
        Signed in as <span className="font-bold text-charcoal">{email ?? "…"}</span>
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void signOut();
        }}
        className="sg-outline min-h-11 min-w-11 flex-none rounded-full border-2 border-indigo bg-transparent px-4 text-sm font-bold text-indigo disabled:opacity-45"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

export function NotStaffNotice({ email }: { email: string | null }) {
  return (
    <Card aria-labelledby="not-staff-h" className="mt-4 flex flex-col gap-2.5">
      <H2 id="not-staff-h">This account isn&rsquo;t store staff</H2>
      <p className="m-0 text-[15px] leading-[1.45]">
        {email ?? "This account"} is signed in, but it isn&rsquo;t on the staff list for any store. Ask a store admin to add
        you, or sign out and use your staff account.
      </p>
    </Card>
  );
}
