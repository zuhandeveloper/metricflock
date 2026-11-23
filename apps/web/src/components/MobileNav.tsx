"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import Sidebar, { type SidebarUser } from "./Sidebar";

// Mobile navigation (Phase 8): the desktop sidebar is hidden below
// md, so small screens get a menu button that opens the same nav as
// a drawer. Closes on navigation, backdrop click, or Escape; focus
// moves to the close button on open and back to the menu button on
// close.
export default function MobileNav({ user }: { user: SidebarUser }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (open) closeButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        openButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        ref={openButtonRef}
        type="button"
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls="mobile-nav-drawer"
        onClick={() => setOpen(true)}
        className="rounded-lg p-2 hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:hover:bg-zinc-800"
      >
        <Menu size={20} aria-hidden="true" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/50"
            aria-hidden="true"
            onClick={() => {
              setOpen(false);
              openButtonRef.current?.focus();
            }}
          />
          <div
            id="mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="relative flex w-64 flex-col bg-white shadow-xl dark:bg-zinc-900"
          >
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close navigation"
              onClick={() => {
                setOpen(false);
                openButtonRef.current?.focus();
              }}
              className="absolute top-2 right-2 rounded-lg p-2 hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:hover:bg-zinc-800"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <Sidebar user={user} />
          </div>
        </div>
      )}
    </div>
  );
}
