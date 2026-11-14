import type { Metadata } from "next";
import { ShopperShell } from "@/components/shopper/ShopperShell";

export const metadata: Metadata = { title: "StoreGuide · Find a product" };

export default function ShopperLayout({ children }: LayoutProps<"/shopper">) {
  return <ShopperShell>{children}</ShopperShell>;
}
