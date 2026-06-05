import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Fraunces, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { MobileMenuProvider } from "@/lib/mobile-menu-context";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

// Studio Ledger typography (canonical post-cutover).
const fraunces = Fraunces({
  subsets: ["latin"],
  weight: "variable",
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz", "SOFT", "WONK"],
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});


export const metadata: Metadata = {
  title: "Org Studio",
  description: "Org design for hybrid human + AI agent teams",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`solarized ${GeistSans.variable} ${GeistMono.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="font-[var(--font-body)] antialiased">
        <ThemeProvider>
          <MobileMenuProvider>
            {children}
            <ToastContainer position="bottom-right" theme="colored" autoClose={3000} />
          </MobileMenuProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
