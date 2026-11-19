// ESLint 10 flat config. Run with `pnpm lint`.
//
// NOTE (2026-11-19): `next/core-web-vitals` (eslint-config-next) cannot be
// used right now — it loads typescript-eslint 8.73.0, and typescript-eslint
// does not support TypeScript 7.0 ("typescript-eslint does not support
// TS 7.0", upstream issue #10940; no stable release supports TS 7 yet).
// This config therefore uses @eslint/js recommended + react-hooks, which
// run cleanly on TS 7. Re-add `next/core-web-vitals` (via FlatCompat) once
// a stable typescript-eslint supports TS 7.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  js.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    ignores: ["node_modules/**", ".next/**", "public/**", "prisma/migrations/**"],
  },
];
