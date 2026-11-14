import type { Metadata } from "next";
import { LegacyTheme } from "@/components/LegacyTheme";
import { BusinessShell } from "@/components/business/BusinessShell";

export const metadata: Metadata = { title: "StoreGuide · Store manager" };

export default function BusinessLayout({ children }: LayoutProps<"/business">) {
  return <LegacyTheme><BusinessShell>{children}</BusinessShell></LegacyTheme>;
}
