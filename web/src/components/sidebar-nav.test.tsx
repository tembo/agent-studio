import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme" }));
vi.mock("@/app/[workspace]/inbox/actions", () => ({ getActiveInboxCountAction: vi.fn() }));
vi.mock("@/components/sidebar-nav-item", () => ({
  SidebarNavItem: ({ href, label }: { href: string; label: string }) => <a href={href}>{label}</a>,
}));

import { SidebarNav } from "./sidebar-nav";

describe("Text messages navigation", () => {
  it.each([true, false, undefined])("honors enabled=%s while retaining other navigation", (enabled) => {
    const html = renderToStaticMarkup(<SidebarNav home="/acme" textMessagesEnabled={enabled} />);
    expect(html.includes('href="/acme/text-messages"')).toBe(enabled === true);
    expect(html).toContain('href="/acme/slack-apps"');
    expect(html).toContain('href="/acme/settings"');
  });
});
