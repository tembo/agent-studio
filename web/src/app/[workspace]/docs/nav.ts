// In-app docs navigation: the published user manual, organized into two
// audiences (Operators / Admins) that ALL users can browse. Page order mirrors
// the public Starlight sidebar (docs/astro.config.mjs); each slug maps to a
// page in the generated DOCS module (lib/docs-content.ts).

export type DocItem = { slug: string; label: string };
export type DocGroup = { label: string; items: DocItem[] };
export type DocSection = { audience: string; groups: DocGroup[] };

export const DOC_SECTIONS: DocSection[] = [
  {
    audience: "For Operators",
    groups: [
      {
        label: "The Basics",
        items: [
          { slug: "introduction", label: "Introduction" },
          { slug: "getting-started", label: "Getting started" },
          { slug: "core-concepts", label: "Core concepts" },
          { slug: "running-agents", label: "Running agents" },
          { slug: "connections", label: "Connections" },
          { slug: "dashboard-and-runs", label: "Dashboard & Runs" },
          { slug: "tasks-inbox", label: "Tasks Inbox" },
          { slug: "automations-triggers", label: "Automations & triggers" },
        ],
      },
      {
        label: "Advanced",
        items: [
          { slug: "authoring-agents", label: "Authoring agents" },
          { slug: "agent-library", label: "Agent library" },
          { slug: "example-agents", label: "Example Agents" },
          { slug: "agent-lifecycle", label: "Agent lifecycle" },
          { slug: "agent-evals", label: "Agent evals" },
          { slug: "sidecar-python-tools", label: "Sidecar Python tools" },
          { slug: "skills", label: "Skills" },
          { slug: "tools-and-tool-uses", label: "Tools & Tool uses" },
          { slug: "improvements", label: "Improvements" },
          { slug: "troubleshooting", label: "Troubleshooting" },
          { slug: "changelog", label: "Changelog" },
          { slug: "roadmap", label: "Roadmap" },
        ],
      },
      {
        label: "Programmatic access",
        items: [
          { slug: "api", label: "REST API" },
          { slug: "mcp", label: "MCP server" },
        ],
      },
    ],
  },
  {
    audience: "For Admins",
    groups: [
      {
        label: "Workspace admin",
        items: [
          { slug: "admin-introduction", label: "Introduction" },
          { slug: "settings", label: "Settings" },
          { slug: "audit-and-roles", label: "Audit & roles" },
          { slug: "slack-apps", label: "Slack apps" },
          { slug: "text-messages", label: "Text messages" },
        ],
      },
      {
        label: "Self-hosting",
        items: [
          { slug: "customer-setup", label: "Setup checklist" },
          { slug: "deploy-railway", label: "Deploy on Railway" },
          { slug: "deploy-aws", label: "Deploy on AWS" },
          { slug: "deploy-vercel", label: "Deploy on Vercel" },
        ],
      },
    ],
  },
  {
    audience: "For Instance Admins",
    groups: [
      {
        label: "The instance",
        items: [
          { slug: "instance-admin", label: "Instance administration" },
        ],
      },
    ],
  },
];

/** All slugs that appear in the nav, for internal-link rewriting. */
export const DOC_SLUGS: Set<string> = new Set(
  DOC_SECTIONS.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.slug))),
);

/** The landing page — first item of the first group. */
export const DOC_HOME_SLUG = DOC_SECTIONS[0].groups[0].items[0].slug;

/** Label for a slug, for the page header / breadcrumbs. */
export function docLabel(slug: string): string | null {
  for (const s of DOC_SECTIONS) {
    for (const g of s.groups) {
      const item = g.items.find((i) => i.slug === slug);
      if (item) return item.label;
    }
  }
  return null;
}
