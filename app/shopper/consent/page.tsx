"use client";
import { useRouter } from "next/navigation";
import { useShopper } from "@/components/shopper/ShopperProvider";
import { sBtn } from "@/components/shopper/ShopperShell";
import { useFocusOnMount } from "@/components/shopper/useFocusOnMount";

export default function ConsentPage() {
  const s = useShopper();
  const router = useRouter();
  const h1 = useFocusOnMount<HTMLHeadingElement>();
  return (
    <>
      <button type="button" onClick={s.back} className={sBtn.back}>‹ Back</button>
      <h1 ref={h1} tabIndex={-1} className={sBtn.h1}>Contribute product information?</h1>
      <p className="m-0 text-[1.05em]">
        This is optional. You can help keep product locations up to date. Search, directions and help work the same if you say no.
      </p>
      <section aria-labelledby="cs-h" className={`flex flex-col gap-[0.5em] ${sBtn.card}`}>
        <h2 id="cs-h" className="m-0 text-[1.05em] font-extrabold">If you allow it, StoreGuide may collect:</h2>
        <ul className="m-0 flex flex-col gap-[0.25em] pl-[1.2em]">
          <li>Product images or camera observations</li>
          <li>Suggested product names and categories</li>
          <li>Estimated product locations</li>
          <li>Observation timestamps</li>
          <li>Store and shelf identifiers</li>
          <li>Recognition confidence and supporting evidence</li>
        </ul>
      </section>
      <p className="m-0 text-[1em]">
        Approved store employees review every observation before anything is published. Unreviewed observations are never used for directions.
      </p>
      <p className="m-0 text-[1em]">
        Camera permission is separate. Allowing the camera does not send anything. Observations are only sent during a scan you start, and only when you choose Submit. Video is never uploaded continuously, and StoreGuide avoids keeping images of other people.
      </p>
      <button
        type="button"
        onClick={() => {
          s.setPrefs({ contributions: "allowed" });
          s.say("Product contributions allowed. Nothing is sent until you start a scan and choose Submit.");
          router.replace("/shopper/contribute");
        }}
        className={`${sBtn.primary} px-4 text-[1.1em]`}
      >
        Allow Product Contributions
      </button>
      <button
        type="button"
        onClick={() => {
          s.setPrefs({ contributions: "declined" });
          s.say("Product contributions are off. Search and help still work.");
          s.back();
        }}
        className={`${sBtn.secondary} px-4 text-[1.1em]`}
      >
        Continue Without Contributing
      </button>
      <p className="m-0 text-[0.9em] text-(--s-muted)">You can change this anytime in Accessibility and privacy settings.</p>
    </>
  );
}
