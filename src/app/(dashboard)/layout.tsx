import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // #1495 Bug 2 — use `fixed inset-0` instead of `h-screen` for the outermost
  // wrapper. h-screen + overflow-hidden relies on the body having a bounded
  // height; the app's html/body have no explicit height, so the wrapper was
  // 100vh tall but the body itself was unbounded — inner focus/click events
  // or iOS address-bar shifts could scroll the body, dragging the wrapper
  // (and the TopBar) partway above the viewport. From the user's POV the
  // nav "sometimes scrolls partway off-screen."
  //
  // `fixed inset-0` anchors the dashboard chrome to the viewport directly,
  // independent of body height. The TopBar stays a normal flex-positioned
  // child (NOT position:fixed itself — that would introduce its own
  // layout-shift bugs per the ticket constraint). The only scroll container
  // is still the inner <main>, which is exactly where scrolling belongs.
  //
  // This is scoped to the dashboard layout, so non-dashboard routes (login,
  // signup) keep normal body-scroll behavior — important for forms that can
  // exceed the viewport on small screens.
  return (
    <div className="fixed inset-0 flex overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto">
          <div className="p-4 sm:p-6 max-w-[1600px] mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
