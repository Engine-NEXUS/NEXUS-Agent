/**
 * OAuth2 PKCE client for NEXUS desktop app.
 *
 * Flow:
 *  1. Generate PKCE verifier + challenge (SHA-256, base64url).
 *  2. Ask sidecar for the provider's authorization URL (includes our challenge).
 *  3. Open the system browser to that URL.
 *  4. User logs in → provider redirects to nexus://oauth/callback?code=XXX.
 *  5. Tauri deep-link plugin catches the redirect and emits an event.
 *  6. We extract the code + state, send code + verifier to sidecar /oauth/exchange.
 *  7. Sidecar exchanges code for tokens (using client secret stored server-side).
 *  8. Tokens are stored per-user on the server. Client gets "connected" confirmation.
 *
 * For API keys (Claude, Devin, etc.) — no OAuth needed. User pastes the key,
 * we POST it to sidecar /apikeys/add.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";

// The sidecar base URL. In production this comes from the saved config.
// The setup page sets this from the user's input.
let sidecarBaseUrl = "";

export function setSidecarBaseUrl(url: string): void {
  // Strip trailing slash.
  sidecarBaseUrl = url.replace(/\/+$/, "");
}

export function getSidecarBaseUrl(): string {
  return sidecarBaseUrl;
}

// ---- PKCE utilities ----

/** Generate a cryptographically random PKCE code verifier (43-128 chars). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Derive the code challenge from the verifier (SHA-256, base64url). */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

/** Base64URL encode (no padding) — per RFC 7636. */
function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---- OAuth connect flow ----

/** Pending OAuth state — stored while waiting for the browser redirect. */
interface PendingOAuth {
  provider: string;
  codeVerifier: string;
  userId: string;
  resolve: (success: boolean) => void;
  reject: (err: Error) => void;
}

let pending: PendingOAuth | null = null;
let unlistenDeepLink: UnlistenFn | null = null;

/**
 * Connect a Google or GitHub account via OAuth PKCE.
 *
 * Returns a promise that resolves when the OAuth flow completes (or rejects on error/timeout).
 */
export async function connectOAuth(
  provider: "google" | "github",
  userId: string,
): Promise<boolean> {
  if (!sidecarBaseUrl) {
    throw new Error("Server URL not configured. Enter your server URL first.");
  }

  // GitHub OAuth apps don't support PKCE, but we still use state for CSRF.
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // 1. Ask sidecar for the authorization URL.
  const authUrlResp = await fetch(
    `${sidecarBaseUrl}/oauth/auth-url?provider=${provider}&user_id=${encodeURIComponent(userId)}&code_challenge=${codeChallenge}`,
  );
  if (!authUrlResp.ok) {
    const err = await authUrlResp.json().catch(() => ({}));
    throw new Error(err.error || `Failed to get OAuth URL (${authUrlResp.status})`);
  }
  const { url } = await authUrlResp.json();

  // 2. Open the system browser for the user to log in.
  await open(url);

  // 3. Set up the deep-link listener BEFORE the redirect comes back.
  const result = await new Promise<boolean>((resolve, reject) => {
    pending = { provider, codeVerifier, userId, resolve, reject };

    // Listen for the nexus://oauth/callback redirect.
    if (!unlistenDeepLink) {
      listen<string>("deep-link://oauth-callback", (event) => {
        handleOAuthRedirect(event.payload).catch((err) => {
          console.error("OAuth redirect handling failed:", err);
        });
      }).then((fn) => {
        unlistenDeepLink = fn;
      });
    }

    // Also check if the app was started via a deep link (Windows/Linux single-instance).
    invoke<string | null>("deep_link_get_current").then((url) => {
      if (url && url.startsWith("nexus://oauth/")) {
        handleOAuthRedirect(url).catch(console.error);
      }
    }).catch(() => {/* not available on this platform */});

    // Timeout after 5 minutes.
    setTimeout(() => {
      if (pending) {
        pending.reject(new Error("OAuth timed out — no redirect received within 5 minutes"));
        pending = null;
      }
    }, 5 * 60 * 1000);
  });

  return result;
}

/** Handle the OAuth redirect URL (nexus://oauth/callback?code=XXX&state=YYY). */
async function handleOAuthRedirect(rawUrl: string): Promise<void> {
  if (!pending) return;

  const url = new URL(rawUrl);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    pending.reject(new Error(`OAuth error: ${error}`));
    pending = null;
    return;
  }

  if (!code) {
    pending.reject(new Error("OAuth redirect missing code parameter"));
    pending = null;
    return;
  }

  // Exchange the code for tokens via the sidecar.
  try {
    const resp = await fetch(`${sidecarBaseUrl}/oauth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: pending.provider,
        code,
        code_verifier: pending.codeVerifier,
        redirect_uri: "nexus://oauth/callback",
        user_id: pending.userId,
        state,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Exchange failed (${resp.status})`);
    }

    pending.resolve(true);
  } catch (err) {
    pending.reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    pending = null;
  }
}

// ---- API key management ----

/** Store an API key for a third-party service (Claude, Devin, etc.). */
export async function addApiKey(userId: string, provider: string, apiKey: string): Promise<void> {
  if (!sidecarBaseUrl) throw new Error("Server URL not configured");
  const resp = await fetch(`${sidecarBaseUrl}/apikeys/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, provider, api_key: apiKey }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Failed to store API key (${resp.status})`);
  }
}

/** Remove a stored API key. */
export async function removeApiKey(userId: string, provider: string): Promise<void> {
  if (!sidecarBaseUrl) throw new Error("Server URL not configured");
  const resp = await fetch(`${sidecarBaseUrl}/apikeys/remove`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, provider }),
  });
  if (!resp.ok) throw new Error(`Failed to remove API key (${resp.status})`);
}

/** List which API key providers are stored (does NOT return the keys). */
export async function listApiKeys(userId: string): Promise<string[]> {
  if (!sidecarBaseUrl) return [];
  const resp = await fetch(`${sidecarBaseUrl}/apikeys/list?user_id=${encodeURIComponent(userId)}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.providers || [];
}

// ---- OAuth status ----

export interface OAuthStatus {
  connected: boolean;
  expired: boolean;
  scopes: string;
}

/** Check which OAuth providers are connected for a user. */
export async function getOAuthStatus(userId: string): Promise<Record<string, OAuthStatus>> {
  if (!sidecarBaseUrl) return {};
  const resp = await fetch(`${sidecarBaseUrl}/oauth/status?user_id=${encodeURIComponent(userId)}`);
  if (!resp.ok) return {};
  const data = await resp.json();
  return data.providers || {};
}

/** Disconnect an OAuth provider. */
export async function disconnectOAuth(userId: string, provider: string): Promise<void> {
  if (!sidecarBaseUrl) throw new Error("Server URL not configured");
  const resp = await fetch(`${sidecarBaseUrl}/oauth/disconnect`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, provider }),
  });
  if (!resp.ok) throw new Error(`Failed to disconnect (${resp.status})`);
}

/** Open a URL in the system browser. */
export async function openInBrowser(url: string): Promise<void> {
  await open(url);
}
