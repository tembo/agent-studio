export const UNAVAILABLE_RUN_IDENTITY = "Unavailable member";

export function runIdentityLabel(
  name: string | null,
  email: string | null,
): string {
  const displayName = name?.trim();
  if (displayName) return displayName;

  const displayEmail = email?.trim();
  return displayEmail || UNAVAILABLE_RUN_IDENTITY;
}
