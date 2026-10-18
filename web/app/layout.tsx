import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Big_Shoulders, IBM_Plex_Mono } from "next/font/google";
import { AppShell } from "@/components/shell";
import { THEME_BOOT } from "@/lib/theme";
import "./globals.css";

const shoulders = Big_Shoulders({ subsets: ["latin"], weight: ["700", "800"], variable: "--font-shoulders", adjustFontFallback: false });
const atkinson = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-atkinson" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: { default: "ComixCenter", template: "%s · ComixCenter" },
  description: "Reading orders, story arcs, characters and teams across every comics universe, plus a reader for the comics you own.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
  appleWebApp: { capable: true, title: "ComixCenter", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#101216" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${shoulders.variable} ${atkinson.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} /></head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
