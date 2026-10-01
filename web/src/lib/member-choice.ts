export type MemberChoice = { id: string; label: string };

export function memberChoice(id: string, name: string | null | undefined, email: string): MemberChoice {
  return { id, label: name ? `${name} (${email})` : email };
}
