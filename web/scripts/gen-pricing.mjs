// Docker builds api/ and web/ independently; check in the web copies.
import { copyFileSync } from "node:fs";
for (const file of ["model-pricing.json", "model-capabilities.json"]) {
  copyFileSync(
    new URL("../../api/src/" + file, import.meta.url),
    new URL("../src/lib/" + file, import.meta.url),
  );
}
