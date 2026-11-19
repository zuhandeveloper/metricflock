"use client";
import { createAuthClient } from "better-auth/react";

// Client-side better-auth. Talks to the mounted handler at /api/auth/[...all].
// The login page still posts to /api/auth/login (a thin better-auth wrapper),
// so this client is for future client-side flows (sign-up, profile, sign-out).
export const authClient = createAuthClient();
export const { signIn, signOut, signUp, useSession } = authClient;
