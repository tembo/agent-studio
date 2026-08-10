import { redirect } from "next/navigation";

import { OAuthConsentCard } from "@/app/oauth/consent/consent-card";
import { getServerSession } from "@/lib/session";
import { listWorkspacesForUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function OAuthConsentPage() {
  const session = await getServerSession();
  if (!session) redirect("/");
  const workspaces = await listWorkspacesForUser(session.user.id);

  return (
    <main className="bg-surface flex min-h-screen items-center justify-center px-6 py-12">
      <OAuthConsentCard
        workspaces={workspaces.map(({ id, name, slug }) => ({ id, name, slug }))}
      />
    </main>
  );
}
