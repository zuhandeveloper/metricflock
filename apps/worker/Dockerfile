# MetricFlock worker — BullMQ job consumer (apps/worker).
#
# Wiring only (ADR-0006): the worker is a long-running Node process and must
# NOT run on Cloudflare Workers (BullMQ needs a persistent Redis
# connection). Host it on a plain VM / Render / Fly.io / Railway worker
# service. Build the image from the REPO ROOT so the workspace packages
# resolve:
#   docker build -f apps/worker/Dockerfile -t metricflock-worker .
#
# Required env at runtime (no .env file is baked in):
#   DATABASE_URL, REDIS_URL, GOOGLE_TOKEN_ENCRYPTION_KEY
# Do NOT give the worker SESSION_SECRET / BETTER_AUTH_SECRET — it never
# needs them (target architecture §6). The process exits 1 when REDIS_URL
# is missing; the host should restart it on exit.
FROM node:26-slim

WORKDIR /app

# Build-time placeholder so `prisma generate` (run by the root
# postinstall) can load prisma.config.ts, which requires DATABASE_URL.
# Nothing connects at build time; the host's real DATABASE_URL replaces
# this at runtime. Node 25+ ships without corepack, so install pnpm
# directly with npm instead.
ENV DATABASE_URL="postgresql://user:pass@127.0.0.1:1/db?sslmode=disable"
RUN npm install -g pnpm@12.21.0

# Whole repo (see .dockerignore: node_modules, .next, .turbo, .git, .env
# are excluded). The worker imports the workspace packages as TS source,
# so they must be present; `pnpm install` links them.
COPY . .
RUN pnpm install --frozen-lockfile

USER node
# OPS-5/9: exec-form CMD so node is PID 1 and receives SIGTERM directly
# (the pnpm→cross-env→tsx chain does not forward signals). tsx loader runs
# the TS source; dotenv config path matches the dev/start scripts.
# Run from the worker directory: `node --import tsx` resolves the loader
# from the CWD, and tsx lives in apps/worker/node_modules (a runtime
# dependency of @metricflock/worker), not in /app/node_modules.
WORKDIR /app/apps/worker
ENV DOTENV_CONFIG_PATH=/app/apps/web/.env
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/index.ts"]
