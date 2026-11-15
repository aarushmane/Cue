import type { Metadata } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: "StoreGuide Scene",
  description: "Matterport 3D scene viewer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body><TooltipProvider delayDuration={250} disableHoverableContent>{children}</TooltipProvider></body>
    </html>
  );
}
