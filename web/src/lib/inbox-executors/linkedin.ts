import "server-only";

import { archiveConversation, sendMessage } from "@/lib/linkedin/voyager";

import type { InboxExecutor } from "./index";

// Executes inbox actions whose option.execute.provider === "linkedin", against
// LinkedIn via the Voyager client. `params.convId` is the conversation id the
// producing agent stored on the option. For "send", `text` is the (possibly
// human-edited) reply.
export const linkedinExecutor: InboxExecutor = async ({ workspaceId, userId, op, params, text }) => {
  const convId = typeof params?.convId === "string" ? params.convId : null;
  if (!convId) throw new Error("linkedin action missing params.convId");

  switch (op) {
    case "send": {
      const body = (text ?? "").trim();
      if (!body) throw new Error("Reply text is empty.");
      await sendMessage(workspaceId, userId, convId, body);
      return;
    }
    case "send_and_archive": {
      const body = (text ?? "").trim();
      if (!body) throw new Error("Reply text is empty.");
      await sendMessage(workspaceId, userId, convId, body);
      await archiveConversation(workspaceId, userId, convId);
      return;
    }
    case "archive":
      await archiveConversation(workspaceId, userId, convId);
      return;
    default:
      throw new Error(`Unknown linkedin op "${op}".`);
  }
};
