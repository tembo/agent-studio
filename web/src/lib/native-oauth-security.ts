import "server-only";

import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

const privateIpBlocks = new BlockList();

privateIpBlocks.addSubnet("0.0.0.0", 8, "ipv4");
privateIpBlocks.addSubnet("10.0.0.0", 8, "ipv4");
privateIpBlocks.addSubnet("100.64.0.0", 10, "ipv4");
privateIpBlocks.addSubnet("127.0.0.0", 8, "ipv4");
privateIpBlocks.addSubnet("169.254.0.0", 16, "ipv4");
privateIpBlocks.addSubnet("172.16.0.0", 12, "ipv4");
privateIpBlocks.addSubnet("192.0.0.0", 24, "ipv4");
privateIpBlocks.addSubnet("192.0.2.0", 24, "ipv4");
privateIpBlocks.addSubnet("192.168.0.0", 16, "ipv4");
privateIpBlocks.addSubnet("198.18.0.0", 15, "ipv4");
privateIpBlocks.addSubnet("198.51.100.0", 24, "ipv4");
privateIpBlocks.addSubnet("203.0.113.0", 24, "ipv4");
privateIpBlocks.addSubnet("224.0.0.0", 4, "ipv4");
privateIpBlocks.addSubnet("240.0.0.0", 4, "ipv4");
privateIpBlocks.addAddress("255.255.255.255", "ipv4");

privateIpBlocks.addAddress("::", "ipv6");
privateIpBlocks.addAddress("::1", "ipv6");
// Translation/tunnel ranges can encode an otherwise blocked IPv4 target.
privateIpBlocks.addSubnet("64:ff9b::", 96, "ipv6");
privateIpBlocks.addSubnet("64:ff9b:1::", 48, "ipv6");
privateIpBlocks.addSubnet("2002::", 16, "ipv6");
privateIpBlocks.addSubnet("::", 96, "ipv6");
privateIpBlocks.addSubnet("100::", 64, "ipv6");
privateIpBlocks.addSubnet("2001::", 23, "ipv6");
privateIpBlocks.addSubnet("2001:2::", 48, "ipv6");
privateIpBlocks.addSubnet("2001:db8::", 32, "ipv6");
privateIpBlocks.addSubnet("fc00::", 7, "ipv6");
privateIpBlocks.addSubnet("fe80::", 10, "ipv6");
privateIpBlocks.addSubnet("ff00::", 8, "ipv6");

function ipv4FromMappedIpv6(address: string): string | null {
  const lower = address.toLowerCase();
  const prefix = lower.startsWith("::ffff:")
    ? "::ffff:"
    : lower.startsWith("0:0:0:0:0:ffff:")
      ? "0:0:0:0:0:ffff:"
      : null;
  if (!prefix) return null;

  const pieces = lower.slice(prefix.length).split(":");
  if (pieces.length !== 2) return null;
  const high = Number.parseInt(pieces[0], 16);
  const low = Number.parseInt(pieces[1], 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return !privateIpBlocks.check(address, "ipv4");
  }
  if (version === 6) {
    const mappedIpv4 = ipv4FromMappedIpv6(address);
    if (mappedIpv4) return isPublicIpAddress(mappedIpv4);
    return !privateIpBlocks.check(address, "ipv6");
  }
  return false;
}

function endpointHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function parseHttpsUrl(rawUrl: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials.`);
  }
  if (!url.hostname) {
    throw new Error(`${label} must include a host.`);
  }
  const hostname = endpointHostname(url);
  const literalIp = isIP(hostname);
  if (literalIp !== 0 && !isPublicIpAddress(hostname)) {
    throw new Error(`${label} resolves to a non-public IP address.`);
  }
  return url;
}

async function assertPublicDns(url: URL, label: string): Promise<void> {
  const hostname = endpointHostname(url);
  if (isIP(hostname) !== 0) return;

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error(`${label} did not resolve to any IP addresses.`);
  }
  const blocked = records.find((record) => !isPublicIpAddress(record.address));
  if (blocked) {
    throw new Error(
      `${label} resolves to a non-public IP address (${blocked.address}).`,
    );
  }
}

/** Validate an MCP server URL (https + public DNS) and return its origin. The
 *  URL is the catalog's fixed `mcpServerUrl` for normal providers, or the
 *  per-connection resolved URL for instance-based (self-hosted) ones. */
export async function trustedMcpOrigin(mcpServerUrl: string): Promise<string> {
  const url = parseHttpsUrl(mcpServerUrl, "MCP server URL");
  await assertPublicDns(url, "MCP server URL");
  return url.origin;
}

/** Validate an OAuth endpoint URL against an explicit set of allowed origins
 *  (https + origin-allowlist + public DNS). For fixed providers the caller
 *  passes the catalog's `oauthAuthorizationServerOrigins`; for instance-based
 *  providers it passes `[the user-entered instance origin]` — a same-origin
 *  constraint (every endpoint must live on the host the operator typed). */
export async function trustedOAuthUrl(
  rawUrl: string,
  allowedOrigins: string[],
  label: string,
): Promise<URL> {
  const url = parseHttpsUrl(rawUrl, label);
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error(`${label} is not on an allowed provider origin.`);
  }
  await assertPublicDns(url, label);
  return url;
}

// Validate the answers used by the socket itself, not only an earlier lookup.
// Returning these exact records prevents a second DNS lookup/rebinding between
// validation and connect while retaining hostname-based TLS/SNI verification.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  void lookup(hostname, { all: true, verbatim: true }).then(
    (records) => {
      if (
        !records.length ||
        records.some((record) => !isPublicIpAddress(record.address))
      ) {
        callback(
          new Error("OAuth endpoint resolves to a non-public IP address."),
          "",
        );
        return;
      }
      const family =
        options.family === "IPv4"
          ? 4
          : options.family === "IPv6"
            ? 6
            : options.family;
      const matching = family
        ? records.filter((record) => record.family === family)
        : records;
      if (!matching.length) {
        callback(
          new Error(
            "OAuth endpoint has no addresses for the requested family.",
          ),
          "",
        );
      } else if (options.all) {
        callback(null, matching);
      } else {
        callback(null, matching[0].address, matching[0].family);
      }
    },
    (error: Error) => callback(error, ""),
  );
};

const publicDispatcher = new Agent({
  connect: { lookup: publicLookup, timeout: 10_000 },
});

/** Server-side OAuth requests must use this transport, including discovery
 *  and DCR. Callers cannot override the dispatcher, follow redirects, or use
 *  a proxy that resolves the destination outside the checked DNS lookup. */
export async function fetchOAuthEndpoint(
  rawUrl: string | URL,
  allowedOrigins: string[],
  label: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = await trustedOAuthUrl(String(rawUrl), allowedOrigins, label);
  const timeout = AbortSignal.timeout(30_000);
  const requestInit: RequestInit & { dispatcher: Agent } = {
    ...init,
    dispatcher: publicDispatcher,
    redirect: "manual",
    cache: "no-store",
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  };
  return fetch(url, requestInit);
}
