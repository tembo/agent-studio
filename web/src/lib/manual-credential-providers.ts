// Catalog of "manual credential" connection providers: services with no OAuth /
// MCP, connected by pasting a few values (e.g. a session cookie) with setup
// instructions. Each field is stored as a workspace secret under field.key — so
// the runtime (sidecar tools via tas_tools.secret, server executors via
// getSharedSecretConnectionValue) reads them exactly as before; this only adds a
// grouped, instructions-driven connect UX on top of the existing secret store.
//
// Not server-only: the (non-secret) catalog — labels, fields, instructions — is
// read by client connect/edit forms too. The values never live here.

export type ManualCredentialField = {
  /** Storage slug AND the name the runtime reads. Must be a valid secret slug. */
  key: string;
  label: string;
  type: "text" | "password";
  required: boolean;
  help?: string;
  placeholder?: string;
};

export type ManualCredentialProvider = {
  slug: string;
  displayName: string;
  /** Markdown shown above the connect form. */
  instructions: string;
  fields: ManualCredentialField[];
};

export const MANUAL_CREDENTIAL_PROVIDERS: Record<string, ManualCredentialProvider> = {
  linkedin: {
    slug: "linkedin",
    displayName: "LinkedIn",
    instructions: [
      "LinkedIn has no official inbox API, so TAS acts as your own logged-in",
      "session. You'll paste three values from a browser where you're signed in.",
      "Use a **desktop** browser (any browser — Chrome/Safari/Firefox/Arc/Dia):",
      "the Voyager API these calls hit is the desktop web client, so a mobile",
      "User-Agent can get redirected.",
      "",
      "1. Sign in to LinkedIn in a desktop browser.",
      "2. Open DevTools → **Application → Cookies → `https://www.linkedin.com`**.",
      "3. Copy the **`li_at`** cookie value.",
      "4. Copy the **`JSESSIONID`** cookie value — strip the surrounding quotes.",
      "5. In DevTools → **Network**, click any `linkedin.com` request and copy the",
      "   **`User-Agent`** request header **verbatim**. It must match the exact",
      "   browser you captured the cookie in — LinkedIn binds the session to it,",
      "   and a mismatch forces a re-auth.",
      "",
      "⚠️ This rides your real LinkedIn session (same as tools like Unipile, just",
      "unmanaged). Respect LinkedIn's rate limits; aggressive use can flag the account.",
      "",
      "**If the LinkedIn agent later fails fetching messages (a 500),** LinkedIn has",
      "probably rotated its internal API IDs (it does this every few releases).",
      "Re-capture: linkedin.com/messaging → DevTools → Network → filter",
      "`messengerConversations` → reload → copy the new `queryId` into the agent's",
      "`linkedin_tools.py`.",
    ].join("\n"),
    fields: [
      {
        key: "linkedin_li_at",
        label: "li_at cookie",
        type: "password",
        required: true,
        help: "The li_at session cookie value.",
        placeholder: "AQEDAR…",
      },
      {
        key: "linkedin_jsessionid",
        label: "JSESSIONID",
        type: "password",
        required: true,
        help: "The JSESSIONID cookie value, without the surrounding quotes.",
        placeholder: "ajax:1234567890",
      },
      {
        key: "linkedin_user_agent",
        label: "User agent",
        type: "text",
        required: true,
        help: "Your browser's User-Agent header — must match the browser the cookie came from.",
        placeholder: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) …",
      },
    ],
  },
};

export function listManualCredentialProviders(): ManualCredentialProvider[] {
  return Object.values(MANUAL_CREDENTIAL_PROVIDERS);
}

export function getManualCredentialProvider(
  slug: string,
): ManualCredentialProvider | null {
  return MANUAL_CREDENTIAL_PROVIDERS[slug] ?? null;
}

/** Every secret slug owned by any manual-credential provider — used to hide
 *  these from the individual secrets list (they show as one grouped row). */
export function manualCredentialSecretSlugs(): Set<string> {
  const s = new Set<string>();
  for (const p of listManualCredentialProviders()) {
    for (const f of p.fields) s.add(f.key);
  }
  return s;
}
