"use client";
import { useRouter } from "next/navigation";
import { useShopper } from "@/components/shopper/ShopperProvider";
import { sBtn } from "@/components/shopper/ShopperShell";
import { useFocusOnMount } from "@/components/shopper/useFocusOnMount";

export default function HelpPage() {
  const s = useShopper();
  const router = useRouter();
  const h1 = useFocusOnMount<HTMLHeadingElement>();
  return (
    <>
      <button type="button" onClick={s.back} className={sBtn.back}>‹ Back</button>
      <h1 ref={h1} tabIndex={-1} className={sBtn.h1}>Get help</h1>
      <p className="m-0 text-[1.1em]">The help desk is at the front of the store, on the far right from the entrance. Any staff member can also help you.</p>
      <p className={`m-0 text-[1em] ${sBtn.card}`}>This prototype cannot contact staff for you. No message has been sent.</p>
      <button
        type="button"
        onClick={() => s.say("The help desk is at the front of the store, on the far right from the entrance. This prototype cannot contact staff for you.")}
        className={`${sBtn.primary} px-4 text-[1.15em]`}
      >
        Hear this
      </button>
      <button
        type="button"
        onClick={() => {
          s.setQ("");
          s.setMsg("");
          router.push("/shopper");
        }}
        className={`${sBtn.secondary} px-4 text-[1.15em]`}
      >
        Start over
      </button>
    </>
  );
}
