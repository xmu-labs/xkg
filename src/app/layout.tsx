import type { Metadata, Viewport } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";

// Inter for the UI, Sora for headings and the wordmark (Lunar Graphite brand).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const sora = Sora({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-sora", display: "swap" });

export const metadata: Metadata = {
  title: "xkg",
  applicationName: "xkg",
  description: "A knowledge graph for your AI workers.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "xkg",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 24x24 32x32 48x48 64x64 128x128 256x256", type: "image/x-icon" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-64.png", sizes: "64x64", type: "image/png" },
      { url: "/favicon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-icon",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F2F1F6" },
    { media: "(prefers-color-scheme: dark)", color: "#11131A" },
  ],
};

const THEME_BOOT = `(function(){try{var t=localStorage.getItem("xkg-theme")||localStorage.getItem("xmu-theme")||localStorage.getItem("mnemos-theme");if(t!=="dark"&&t!=="light")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${sora.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <meta name="apple-mobile-web-app-title" content="xkg" />
        <meta name="application-name" content="xkg" />
      </head>
      <body>{children}</body>
    </html>
  );
}
