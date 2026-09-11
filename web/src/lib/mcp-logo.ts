// Resolve a provider slug to its logo URL.
//
// Most provider logos come from Composio's public logo CDN (every Composio
// toolkit slug — slack, linear, attio, hubspot, … — resolves there, and our
// native-MCP slugs mostly reuse those same slugs). Two escape hatches:
//
//  - CDN_SLUG_ALIASES: our slug differs from Composio's (they use underscores
//    for some multi-word brands — new_relic, help_scout, …).
//  - LOCAL_LOGOS: the provider isn't in Composio's catalog at all. The CDN
//    doesn't 404 for unknown slugs — it serves a generic fallback glyph — so
//    "missing" was detected by hashing responses against that fallback
//    (2026-07-18 sweep), and we ship local art (official favicons /
//    apple-touch-icons) instead.
//
// Pure data + string building (no server-only deps) so both server components
// and the client logo widgets can call it. Callers keep their own onError
// fallback to a generic glyph, so a missing/blocked URL still degrades cleanly.

// Composio catalogs these brands under different slugs than ours.
const CDN_SLUG_ALIASES: Record<string, string> = {
  newrelic: "new_relic",
  launchdarkly: "launch_darkly",
  huggingface: "hugging_face",
  helpscout: "help_scout",
  surveymonkey: "survey_monkey",
};

const LOCAL_LOGOS: Record<string, string> = {
  "tembo-agent-studio": "/favicons/default-tembo.svg",
  pylon: "/mcp-logos/pylon.svg",
  dialed: "/mcp-logos/dialed.svg",
  amplemarket: "/mcp-logos/amplemarket.svg",
  avoma: "/mcp-logos/avoma.png",
  // 2026-07 batch-3 sweep: not in Composio's catalog (CDN serves its generic
  // fallback for these) — official favicons/apple-touch-icons shipped locally.
  aha: "/mcp-logos/aha.png",
  atlan: "/mcp-logos/atlan.png",
  bigquery: "/mcp-logos/bigquery.png",
  carta: "/mcp-logos/carta.png",
  cbinsights: "/mcp-logos/cbinsights.png",
  chargebee: "/mcp-logos/chargebee.png",
  chilipiper: "/mcp-logos/chilipiper.png",
  circleback: "/mcp-logos/circleback.png",
  clarify: "/mcp-logos/clarify.png",
  commonroom: "/mcp-logos/commonroom.png",
  consensus: "/mcp-logos/consensus.png",
  craft: "/mcp-logos/craft.png",
  crossbeam: "/mcp-logos/crossbeam.png",
  daloopa: "/mcp-logos/daloopa.png",
  dayai: "/mcp-logos/dayai.png",
  deepl: "/mcp-logos/deepl.png",
  digits: "/mcp-logos/digits.png",
  drata: "/mcp-logos/drata.png",
  enterpret: "/mcp-logos/enterpret.png",
  eraser: "/mcp-logos/eraser.ico",
  gocardless: "/mcp-logos/gocardless.png",
  granola: "/mcp-logos/granola.png",
  harmonic: "/mcp-logos/harmonic.png",
  harvey: "/mcp-logos/harvey.png",
  honeycomb: "/mcp-logos/honeycomb.png",
  ifttt: "/mcp-logos/ifttt.png",
  indeed: "/mcp-logos/indeed.png",
  instantdb: "/mcp-logos/instantdb.png",
  ironclad: "/mcp-logos/ironclad.png",
  kernel: "/mcp-logos/kernel.png",
  knock: "/mcp-logos/knock.png",
  krisp: "/mcp-logos/krisp.png",
  lorikeet: "/mcp-logos/lorikeet.png",
  lovable: "/mcp-logos/lovable.png",
  lucid: "/mcp-logos/lucid.png",
  mercadopago: "/mcp-logos/mercadopago.png",
  mercury: "/mcp-logos/mercury.png",
  metaview: "/mcp-logos/metaview.png",
  montecarlo: "/mcp-logos/montecarlo.png",
  morningstar: "/mcp-logos/morningstar.png",
  motherduck: "/mcp-logos/motherduck.png",
  navan: "/mcp-logos/navan.png",
  otter: "/mcp-logos/otter.png",
  pitch: "/mcp-logos/pitch.jpg",
  pitchbook: "/mcp-logos/pitchbook.png",
  planetscale: "/mcp-logos/planetscale.ico",
  quartr: "/mcp-logos/quartr.png",
  retool: "/mcp-logos/retool.png",
  salesloft: "/mcp-logos/salesloft.jpg",
  semgrep: "/mcp-logos/semgrep.png",
  signnow: "/mcp-logos/signnow.png",
  similarweb: "/mcp-logos/similarweb.png",
  smartsheet: "/mcp-logos/smartsheet.png",
  staircase: "/mcp-logos/staircase.png",
  statsig: "/mcp-logos/statsig.png",
  stytch: "/mcp-logos/stytch.png",
  superhuman: "/mcp-logos/superhuman.png",
  teamwork: "/mcp-logos/teamwork.png",
  udemy: "/mcp-logos/udemy.png",
  unthread: "/mcp-logos/unthread.png",
  workos: "/mcp-logos/workos.png",
  zapier: "/mcp-logos/zapier.png",
};

export function mcpLogoUrl(slug: string): string {
  const s = slug.trim().toLowerCase();
  const cdnSlug = CDN_SLUG_ALIASES[s] ?? s;
  return (
    LOCAL_LOGOS[s] ?? `https://logos.composio.dev/api/${encodeURIComponent(cdnSlug)}`
  );
}
