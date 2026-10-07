// Docker builds api/ and web/ independently; check in the web copy.
import { copyFileSync } from "node:fs";
copyFileSync(
  new URL("../../api/src/model-pricing.json", import.meta.url),
  new URL("../src/lib/model-pricing.json", import.meta.url),
);
