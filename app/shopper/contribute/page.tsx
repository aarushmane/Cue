"use client";
import { ObservationScan } from "@/components/shopper/ObservationScan";
import { useShopper } from "@/components/shopper/ShopperProvider";
import { sBtn } from "@/components/shopper/ShopperShell";
import { useFocusOnMount } from "@/components/shopper/useFocusOnMount";

export default function ContributePage() {
  const s = useShopper();
  const h1 = useFocusOnMount<HTMLHeadingElement>();
  return (
    <>
      <button type="button" onClick={s.back} className={sBtn.back}>‹ Back</button>
      <h1 ref={h1} tabIndex={-1} className={sBtn.h1}>Help map this store</h1>
      <ObservationScan />
    </>
  );
}
