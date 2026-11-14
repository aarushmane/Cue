import type { Metadata } from "next";
import { InventoryReview } from "./InventoryReview";

export const metadata: Metadata = { title: "Inventory · StoreGuide staff" };

export default function Page() {
  return <InventoryReview />;
}
