# Team Management Guide

- Super Admin creates teams (POST `/api/teams`) and manages users.
- Team Admins add/remove members (POST `/api/teams/[id]/members`, `isAdmin` flag for team admins).
- Team Admins assign members to websites (POST `/api/websites/[id]/assign`).
- Team Members only see websites explicitly assigned to them; they cannot manage teams, connections, or transfers.
