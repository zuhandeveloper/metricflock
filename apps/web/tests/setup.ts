// jest-dom matchers (toBeInTheDocument, toBeDisabled, ...) for component
// tests. Imported via the vitest entry point so it registers on vitest's
// `expect`; safe to load in node-env unit tests too (no DOM access at import).
import "@testing-library/jest-dom/vitest";

// @testing-library/react only auto-registers its DOM cleanup when
// vitest runs with globals:true; this repo does not, so register it
// explicitly — otherwise renders accumulate across tests in a file.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(() => cleanup());

// Recharts' ResponsiveContainer needs ResizeObserver, which jsdom does
// not provide. A no-op stub lets chart components render their
// containers (0-size) without throwing; harmless for node-env tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
