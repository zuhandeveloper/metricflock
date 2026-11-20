# Website Management Guide

- Create: POST `/api/websites` (name, domain, url, team, status, purchase/sale price + dates, notes).
- Statuses: ACTIVE, PENDING_SETUP, DISCONNECTED, TRANSFER_PENDING, SOLD, ARCHIVED.
- Assign to team / reassign: PATCH `/api/websites/[id]` (teamId) or the transfer workflow.
- Connect Google: `/integrations` → connect team or website account → discover → map.
- Check health: IntegrationHealth rows + `/integrations` page (last success, last error).
