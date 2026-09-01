import assert from "node:assert/strict";
import test from "node:test";

import { dependencyStatusLabel } from "./dependency-status.mjs";

const openBlocker = { number: 1, state: "OPEN" };
const closedBlocker = { number: 1, state: "CLOSED" };

test("blocks ready work while a formal dependency is open", () => {
  assert.equal(
    dependencyStatusLabel("status: ready", [openBlocker]),
    "status: blocked",
  );
});

test("returns blocked when any formal dependency remains open", () => {
  assert.equal(
    dependencyStatusLabel("status: blocked", [closedBlocker, openBlocker]),
    "status: blocked",
  );
});

test("moves blocked work to ready after every formal dependency closes", () => {
  assert.equal(
    dependencyStatusLabel("status: blocked", [closedBlocker]),
    "status: ready",
  );
});

test("does not reinterpret blocked work without formal dependencies", () => {
  assert.equal(dependencyStatusLabel("status: blocked", []), null);
});

test("preserves active ownership even when a dependency is open", () => {
  assert.equal(
    dependencyStatusLabel("status: in progress", [openBlocker]),
    null,
  );
});

test("does not promote non-blocked work merely because dependencies closed", () => {
  assert.equal(
    dependencyStatusLabel("status: triage", [closedBlocker]),
    null,
  );
});
