import type { NextRequest } from "next/server";

import { getPublicOrigin } from "@/lib/config";

async function forwardGenericOAuthCallback(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  const callback = new URL(
    `/api/auth/callback/${encodeURIComponent(provider)}`,
    getPublicOrigin(),
  );
  callback.search = request.nextUrl.search;
  return Response.redirect(callback, 307);
}

export const GET = forwardGenericOAuthCallback;
export const POST = forwardGenericOAuthCallback;
