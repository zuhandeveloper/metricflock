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

# pnpm (matches the repo's packageManager field).
RUN corepack enable && corepack prepare pnpm@12.21.0 --activate

# Whole repo (see .dockerignore: node_modules, .next, .turbo, .git, .env
# are excluded). The worker imports the workspace packages as TS source,
# so they must be present; `pnpm install` links them.
COPY . .
RUN pnpm install --frozen-lockfile

USER node
CMD ["pnpm", "--filter", "@metricflock/worker", "start"]
