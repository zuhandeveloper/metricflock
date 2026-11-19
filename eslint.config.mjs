// ESLint 10 flat config. Run with `pnpm lint`.
//
// NOTE (2026-11-19): `next/core-web-vitals` (eslint-config-next) cannot be
// used right now — it loads typescript-eslint 8.73.0, and typescript-eslint
// does not support TypeScript 7.0 ("typescript-eslint does not support
// TS 7.0", upstream issue #10940; no stable release supports TS 7 yet).
// This config therefore uses @eslint/js recommended + react-hooks, which
// run cleanly on TS 7. Re-add `next/core-web-vitals` (via FlatCompat) once
// a stable typescript-eslint supports TS 7.
//
// NOTE (2026-11-19, monorepo step 3.7): the same blocker means ESLint 10
// lints only .js/.mjs/.cjs by default — the .ts/.tsx files are NOT linted
// yet. The `pnpm lint` green checks are real for the config files but
// vacuous for TypeScript. Once a stable typescript-eslint supports TS 7,
// add its parser + `files: ["**/*.ts", "**/*.tsx"]` so the boundary rules
// (added in step 3.8) actually apply to the code.
//
// Ignore patterns use `**/` so they match at any depth: each package and
// app has its own node_modules/.next/.turbo (pnpn workspaces), and a
// top-level-only pattern such as "node_modules/**" does NOT cover them —
// linting every nested node_modules blew the 2 GB heap (step 3.7).
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";

// Shared `patterns` for every boundary block below: no relative import may
// reach into another package or app — cross-package code goes through the
// @metricflock/* package names. (Each block repeats it because in flat
// config a later `no-restricted-imports` would override an earlier one for
// the same files; there is no global block for this rule.)
const crossPackageRelative = {
  patterns: [
    {
      group: ["**/packages/**", "**/apps/**"],
      message: "Do not import another package/app by relative path — import it by its @metricflock/* package name.",
    },
  ],
};

// Package boundaries (target architecture §4, monorepo step 3.8).
// One block per scope, because each scope allows a different set:
//   - only packages/db may import @prisma/client (and better-auth/crypto,
//     which the seed uses for password hashing)
//   - only packages/auth may import better-auth
//   - only packages/google may import googleapis / google-gax /
//     @google-analytics/data
//   - only packages/jobs and apps/worker may import bullmq
//   - only packages/shared may import ioredis
// NOTE: these are dormant for .ts/.tsx today (see the NOTE above) and
// take effect once a TS parser lands. They already apply to .js/.mjs.
const boundaries = [
  {
    files: ["packages/db/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "better-auth", message: "Only packages/auth may import better-auth (db's seed may use better-auth/crypto for password hashing)." },
          { name: "googleapis", message: "Only packages/google may import googleapis." },
          { name: "google-gax", message: "Only packages/google may import google-gax." },
          { name: "@google-analytics/data", message: "Only packages/google may import @google-analytics/data." },
          { name: "bullmq", message: "Only packages/jobs and apps/worker may import bullmq." },
          { name: "ioredis", message: "Only packages/shared may import ioredis." },
        ],
        ...crossPackageRelative,
      }],
    },
  },
  {
    files: ["packages/auth/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@prisma/client", message: "Only packages/db may import @prisma/client — import the prisma client from @metricflock/db instead." },
          { name: "googleapis", message: "Only packages/google may import googleapis." },
          { name: "google-gax", message: "Only packages/google may import google-gax." },
          { name: "@google-analytics/data", message: "Only packages/google may import @google-analytics/data." },
          { name: "bullmq", message: "Only packages/jobs and apps/worker may import bullmq." },
          { name: "ioredis", message: "Only packages/shared may import ioredis." },
        ],
        ...crossPackageRelative,
      }],
    },
  },
  {
    files: ["packages/google/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@prisma/client", message: "Only packages/db may import @prisma/client — import the prisma client from @metricflock/db instead." },
          { name: "better-auth", message: "Only packages/auth may import better-auth." },
          { name: "better-auth/crypto", message: "Only packages/auth (and the db seed) may import better-auth/crypto." },
          { name: "bullmq", message: "Only packages/jobs and apps/worker may import bullmq." },
          { name: "ioredis", message: "Only packages/shared may import ioredis." },
        ],
        ...crossPackageRelative,
      }],
    },
  },
  {
    files: ["packages/jobs/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@prisma/client", message: "Only packages/db may import @prisma/client — import the prisma client from @metricflock/db instead." },
          { name: "better-auth", message: "Only packages/auth may import better-auth." },
          { name: "better-auth/crypto", message: "Only packages/auth (and the db seed) may import better-auth/crypto." },
          { name: "googleapis", message: "Only packages/google may import googleapis." },
          { name: "google-gax", message: "Only packages/google may import google-gax." },
          { name: "@google-analytics/data", message: "Only packages/google may import @google-analytics/data." },
          { name: "ioredis", message: "Only packages/shared may import ioredis." },
        ],
        ...crossPackageRelative,
      }],
    },
  },
  {
    files: ["packages/shared/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@prisma/client", message: "Only packages/db may import @prisma/client — import the prisma client from @metricflock/db instead." },
          { name: "better-auth", message: "Only packages/auth may import better-auth." },
          { name: "better-auth/crypto", message: "Only packages/auth (and the db seed) may import better-auth/crypto." },
          { name: "googleapis", message: "Only packages/google may import googleapis." },
          { name: "google-gax", message: "Only packages/google may import google-gax." },
          { name: "@google-analytics/data", message: "Only packages/google may import @google-analytics/data." },
          { name: "bullmq", message: "Only packages/jobs and apps/worker may import bullmq." },
        ],
        ...crossPackageRelative,
      }],
    },
  },
  {
    files: ["apps/worker/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@prisma/client", message: "Only packages/db may import @prisma/client — import the prisma client from @metricflock/db instead." },
          { name: "better-auth", message: "Only packages/auth may import better-auth." },
          { name: "better-auth/crypto", message: "Only packages/auth (and the db seed) may import better-auth/crypto." },
          { name: "googleapis", message: "Only packages/google may import googleapis." },
          { name: "google-gax", message: "Only packages/google may import google-gax." },
          { name: "@google-analytics/data", message: "Only packages/google may import @google-analytics/data." },
          { name: "ioredis", message: "Only packages/shared may import ioredis." },
        ],
        ...crossPackageRelative,
      }],
    },
  },
  {
    files: ["apps/web/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@prisma/client", message: "Only packages/db may import @prisma/client — import the prisma client from @metricflock/db instead." },
          { name: "better-auth", message: "Only packages/auth may import better-auth." },
          { name: "better-auth/crypto", message: "Only packages/auth (and the db seed) may import better-auth/crypto." },
          { name: "googleapis", message: "Only packages/google may import googleapis." },
          { name: "google-gax", message: "Only packages/google may import google-gax." },
          { name: "@google-analytics/data", message: "Only packages/google may import @google-analytics/data." },
          { name: "bullmq", message: "Only packages/jobs and apps/worker may import bullmq." },
          { name: "ioredis", message: "Only packages/shared may import ioredis." },
        ],
        ...crossPackageRelative,
      }],
    },
  },
];

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
  ...boundaries,
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/.turbo/**", "**/.open-next/**", "**/public/**", "packages/db/prisma/migrations/**"],
  },
];
