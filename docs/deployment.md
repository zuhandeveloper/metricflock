# Deployment Guide
1. Provision Postgres 16 + Redis 7 (`docker compose up -d` for local).
2. Set env vars from `.env.example` in your host (Vercel/host env, or a secret manager).
3. `npm ci && npx prisma migrate deploy && npm run build && npm start`
4. Run the worker separately for background sync: `npm run worker` (needs Redis).
5. Point `GOOGLE_REDIRECT_URI` at the production callback URL and add it in Google Cloud Console.
6. Change the seed admin password immediately; create real users.
7. Submit the OAuth app for Google verification before inviting non-test users.
