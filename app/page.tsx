import Link from "next/link";

// Entry point: choose a surface. Both surfaces share the same verified inventory.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col gap-[22px] px-5 pt-12 pb-7">
      <header className="flex flex-col gap-1.5">
        <p className="m-0 text-[15px] font-semibold text-muted">StoreGuide Demo Market</p>
        <h1 className="m-0 font-display text-[32px] leading-[1.1] font-normal text-indigo">StoreGuide</h1>
        <p className="m-0 text-[17px]">Choose how you are using StoreGuide today.</p>
      </header>
      <nav aria-label="Choose a surface" className="flex flex-col gap-2.5">
        <Link
          href="/shopper"
          className="flex min-h-[72px] flex-col justify-center rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-3.5 text-charcoal no-underline"
        >
          <span className="text-[17px] font-bold">I am shopping</span>
          <span className="text-sm text-muted">Voice-first product search, accessibility and privacy settings</span>
        </Link>
        <Link
          href="/business"
          className="flex min-h-[72px] flex-col justify-center rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-3.5 text-charcoal no-underline"
        >
          <span className="text-[17px] font-bold">I work at this store</span>
          <span className="text-sm text-muted">Review observations, floor plan, inventory and activity</span>
        </Link>
      </nav>
      <p className="m-0 self-start rounded-full bg-tint px-3 py-1 text-[13px] font-semibold">
        Demo store · in-memory demo data, reset when the server restarts
      </p>
    </main>
  );
}
