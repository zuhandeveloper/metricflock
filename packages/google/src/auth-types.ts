import { google } from "googleapis";
// Canonical OAuth2 client type. googleapis bundles its own copy of
// google-auth-library; importing OAuth2Client from the top-level
// "google-auth-library" package resolves to a DIFFERENT copy and breaks
// assignability. Always use this type, derived from googleapis itself.
export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
