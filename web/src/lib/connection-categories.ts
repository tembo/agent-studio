// Connection CATEGORIES for the Agent Library. The library's starter agents
// declare what they need by category ("a CRM", "a call recorder", "Slack to
// notify") rather than a specific vendor — mirroring the source spreadsheet's
// Connection(s) column. We map each category to the toolkit/provider slugs that
// satisfy it (native-MCP providers from mcp-providers.ts + common Composio
// toolkits), so we can tell whether a given user can actually run a starter.
//
// Plain module (no "server-only", no DB, no SDK) — imported by both the server
// page that ranks and the client gallery that renders chips.

export type ConnectionCategory =
  | "crm"
  | "email"
  | "calendar"
  | "notify" // Slack (and other chat notify targets)
  | "helpdesk"
  | "recorder" // call/meeting recorders
  | "accounting"
  | "payments"
  | "analytics"
  | "warehouse"
  | "docs" // docs / knowledge base / templates
  | "issues" // issue trackers / PM / dev
  | "forms"
  | "enrichment"
  | "storage"
  | "ats"
  | "hris"
  | "ims" // inventory management
  | "monitoring"
  | "itsm"
  | "identity" // IAM / SSO / SaaS admin
  | "ads"
  | "seo"
  | "esign"
  | "survey"
  | "psa" // professional-services automation / time tracking
  | "tasks-inbox" // built-in Tembo Agent Studio MCP (produce_inbox_item)
  | "web"; // built-in web search

export type CategoryMeta = {
  /** Display label for chips. */
  label: string;
  /** Toolkit/provider slugs that satisfy the category (lowercased). */
  slugs: string[];
  /** Whether TAS can connect anything in this category yet. false ⇒ the chip
   *  reads "Not yet connectable" and the starter can't be marked ready. */
  supported: boolean;
  /** Built-in capability that needs no user connection (always satisfied). */
  builtin?: boolean;
};

// Slug lists are best-effort and extensible: native-MCP providers are exact,
// Composio toolkits are open-ended so we list the common ones. A long-tail
// category with no realistic TAS connector is marked supported:false rather
// than pretending it's available.
export const CATEGORY_META: Record<ConnectionCategory, CategoryMeta> = {
  crm: { label: "CRM", supported: true, slugs: ["attio", "hubspot", "salesforce", "pipedrive", "close", "copper", "dayai", "clarify"] },
  email: { label: "Email", supported: true, slugs: ["gmail", "outlook", "microsoftoutlook", "resend", "klaviyo", "superhuman"] },
  calendar: { label: "Calendar", supported: true, slugs: ["googlecalendar", "outlookcalendar", "cal", "calendly"] },
  notify: { label: "Slack", supported: true, slugs: ["slack", "microsoftteams", "pagerduty"] },
  helpdesk: { label: "Helpdesk", supported: true, slugs: ["pylon", "zendesk", "intercom", "freshdesk", "front", "helpscout", "gorgias", "plain", "lorikeet", "unthread", "missive"] },
  recorder: { label: "Call recorder", supported: true, slugs: ["avoma", "fathom", "gong", "fireflies", "granola", "zoom", "otter", "grain", "krisp", "circleback", "tldv"] },
  accounting: { label: "Accounting", supported: true, slugs: ["quickbooks", "xero", "netsuite", "digits"] },
  payments: { label: "Payments", supported: true, slugs: ["stripe", "paypal", "square", "gocardless", "mercadopago", "chargebee", "maxio"] },
  analytics: { label: "Product analytics", supported: true, slugs: ["metabase", "amplitude", "mixpanel", "posthog", "googleanalytics", "pendo", "hex", "statsig"] },
  warehouse: { label: "Data warehouse", supported: true, slugs: ["metabase", "snowflake", "bigquery", "motherduck"] },
  docs: { label: "Docs / knowledge", supported: true, slugs: ["notion", "guru", "googledocs", "googledrive", "confluence", "coda", "airtable", "canva", "gitbook", "craft", "mem", "sanity"] },
  issues: { label: "Issue tracker", supported: true, slugs: ["linear", "jira", "atlassian", "github", "asana", "monday", "clickup", "gitlab", "shortcut", "aha", "productboard", "teamwork", "todoist"] },
  forms: { label: "Forms", supported: true, slugs: ["typeform", "googleforms", "jotform", "surveymonkey"] },
  enrichment: { label: "Enrichment", supported: true, slugs: ["clay", "amplemarket", "apollo", "zoominfo", "lusha", "hunter", "harmonic"] },
  storage: { label: "File storage", supported: true, slugs: ["googledrive", "dropbox", "box", "egnyte"] },
  ats: { label: "ATS / recruiting", supported: true, slugs: ["ashby", "workable", "greenhouse", "lever", "metaview", "indeed"] },
  hris: { label: "HRIS", supported: true, slugs: ["gusto", "deel", "bamboohr", "rippling"] },
  // Long-tail categories TAS doesn't have a first-class connector for yet.
  ims: { label: "Inventory", supported: false, slugs: [] },
  // Platform / infra MCPs (Vercel, Railway, Cloudflare, Neon, Datadog, Sentry).
  monitoring: { label: "Monitoring", supported: true, slugs: ["datadog", "sentry", "pagerduty", "grafana", "newrelic", "honeycomb", "incidentio", "rootly", "bugsnag"] },
  itsm: { label: "ITSM", supported: false, slugs: [] },
  identity: { label: "Identity / SSO", supported: false, slugs: [] },
  ads: { label: "Ads", supported: true, slugs: ["klaviyo"] },
  seo: { label: "SEO / search", supported: true, slugs: ["similarweb", "ahrefs", "semrush"] },
  esign: { label: "E-signature", supported: true, slugs: ["docusign", "signnow", "dropboxsign", "pandadoc"] },
  survey: { label: "Survey", supported: true, slugs: ["surveymonkey", "typeform", "jotform"] },
  psa: { label: "PSA / time tracking", supported: false, slugs: [] },
  // Built-ins: no user connection required.
  "tasks-inbox": { label: "Tasks Inbox", supported: true, builtin: true, slugs: ["tembo-agent-studio"] },
  web: { label: "Web search", supported: true, builtin: true, slugs: [] },
};

export type CategoryStatus = {
  category: ConnectionCategory;
  label: string;
  /** The user has a connection that satisfies this category (or it's built-in). */
  satisfied: boolean;
  supported: boolean;
  builtin: boolean;
};

/** Collect the toolkit/provider slugs a user has connected, across substrates,
 *  lowercased into one set for O(1) category lookups. Mirrors the fetch the
 *  sidebar does in [workspace]/layout.tsx. */
export function collectConnectedSlugs(
  composio: { toolkit: string }[],
  native: { type: string }[],
  secrets: { slug: string }[],
): Set<string> {
  const set = new Set<string>();
  for (const c of composio) set.add(c.toolkit.trim().toLowerCase());
  for (const n of native) set.add(n.type.trim().toLowerCase());
  for (const s of secrets) set.add(s.slug.trim().toLowerCase());
  return set;
}

/** Status of one category against a user's connected slugs. */
export function categoryStatus(
  category: ConnectionCategory,
  connected: Set<string>,
): CategoryStatus {
  const meta = CATEGORY_META[category];
  const builtin = meta.builtin === true;
  const satisfied = builtin
    ? true
    : meta.supported && meta.slugs.some((s) => connected.has(s));
  return { category, label: meta.label, satisfied, supported: meta.supported, builtin };
}

export type Rankable = {
  categories: ConnectionCategory[];
  firstWave: boolean;
  score: number;
};

export type Ranked<T extends Rankable> = {
  agent: T;
  /** Every required (non-built-in) category is satisfied. */
  ready: boolean;
  /** Per-category status for chip rendering. */
  categoryStatuses: CategoryStatus[];
};

/** Rank starters: runnable-now first, then First Wave, then impact score. The
 *  caller passes catalog-stable input so ties preserve catalog order. */
export function rankLibrary<T extends Rankable>(
  agents: T[],
  connected: Set<string>,
): Ranked<T>[] {
  const ranked: Ranked<T>[] = agents.map((agent) => {
    const categoryStatuses = agent.categories.map((c) => categoryStatus(c, connected));
    // Built-ins never block; a starter is ready when all the real categories
    // it needs are satisfied.
    const ready = categoryStatuses
      .filter((s) => !s.builtin)
      .every((s) => s.satisfied);
    return { agent, ready, categoryStatuses };
  });
  return ranked
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.ready !== b.r.ready) return a.r.ready ? -1 : 1;
      if (a.r.agent.firstWave !== b.r.agent.firstWave)
        return a.r.agent.firstWave ? -1 : 1;
      if (a.r.agent.score !== b.r.agent.score) return b.r.agent.score - a.r.agent.score;
      return a.i - b.i; // stable: catalog order
    })
    .map(({ r }) => r);
}
