# Ownership Transfer Guide

1. Super Admin calls POST `/api/websites/[id]/transfer` with `toTeamId` + reason.
2. The transaction marks the website TRANSFER_PENDING, records WebsiteTransfer, reassigns the team, removes old member assignments, and preserves history/audit logs.
3. OAuth tokens are NOT transferred. The new team connects its own Google account.
4. Discover + map the new properties, confirm connection health.
5. Mark the transfer COMPLETED (update the WebsiteTransfer row / set website status ACTIVE).
6. Old team members lose access immediately (server-side checks); historical reports stay attached to the website.
