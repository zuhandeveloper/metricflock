import { google } from "googleapis";
import { GoogleAuth } from "google-gax";
// Canonical OAuth2 client type. googleapis bundles its own copy of
// google-auth-library (v10, under googleapis-common); importing OAuth2Client
// from the top-level "google-auth-library" package (v9) resolves to a
// DIFFERENT copy and breaks assignability. Always use this type, derived
// from googleapis itself.
export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
export function toGoogleAuth(auth: OAuth2Client) {
  // The GA4 gax client expects a GoogleAuth from google-gax's copy of
  // google-auth-library. The OAuth2 client comes from googleapis' newer
  // copy; the cast bridges the two copies. At runtime both expose the same
  // getAccessToken/getRequestHeaders surface, and GoogleAuth simply returns
  // the provided client from getClient().
  return new GoogleAuth({ authClient: auth as unknown as never });
}
