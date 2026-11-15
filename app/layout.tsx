import type { Metadata } from "next";
import localFont from "next/font/local";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geist = localFont({
  src: "./fonts/GeistSans.woff2",
  variable: "--font-geist",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "StoreGuide",
  description: "3D scene and wayfinding.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body><TooltipProvider delayDuration={250} disableHoverableContent>{children}</TooltipProvider></body>
    </html>
  );
}
