// Copies the brand binary assets (PNG/ICO) from the repo-root public/ folder
// into apps/web/public/ at install time.
//
// Why: the binaries live at the repo root (pre-monorepo layout) and cannot be
// moved through the GitHub connector (text-only). Next.js serves public/
// from apps/web, so without this copy the deployed site 404s on /og.png,
// /favicon.ico, etc. The copy is a no-op once the files are properly moved
// into apps/web/public/ (source missing or target already present).
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "public");
const dstDir = join(root, "apps", "web", "public");

if (existsSync(srcDir)) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (!/\.(png|ico)$/i.test(name)) continue;
    const dst = join(dstDir, name);
    if (!existsSync(dst)) copyFileSync(join(srcDir, name), dst);
  }
}
