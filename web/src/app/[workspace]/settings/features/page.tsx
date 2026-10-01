import { redirect } from "next/navigation";

export default async function FeaturesSettingsPage({ params }: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  redirect(`/${slug}/settings/general`);
}
