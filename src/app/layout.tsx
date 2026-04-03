import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { MobileMenuProvider } from "@/lib/mobile-menu-context";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";


export const metadata: Metadata = {
  title: "Org Studio",
  description: "Org design for hybrid human + AI agent teams",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="font-[var(--font-body)] antialiased">
        <ThemeProvider>
          <MobileMenuProvider>
            {children}
            <ToastContainer position="bottom-right" theme="dark" autoClose={3000} />
          </MobileMenuProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
