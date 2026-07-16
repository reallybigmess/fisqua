/**
 * Tests — backfill deterministic ids + era constant
 *
 * Pins the properties the whole backfill's idempotency rests on: a
 * given key always hashes to the same UUID (v5, valid variant/version
 * bits), distinct keys diverge, and the stamped `created_at` is the
 * documented Phase-13 constant (2026-04-16Z) — never a run date.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import { uuidv5, PHASE_13_CREATED_AT_MS, BACKFILL_USER_EMAIL } from "../../scripts/backfill/ids";

describe("backfill/ids", () => {
  it("uuidv5 is deterministic for the same key", () => {
    expect(uuidv5("resolve:acc-00002")).toBe(uuidv5("resolve:acc-00002"));
  });

  it("uuidv5 diverges for different keys", () => {
    expect(uuidv5("resolve:acc-00002")).not.toBe(uuidv5("resolve:acc-00003"));
  });

  it("uuidv5 emits a valid v5 UUID (version nibble 5, RFC variant)", () => {
    const id = uuidv5("merge:ortho:acc-08032:acc-00548");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("Phase-13 constant is 2026-04-16T00:00:00Z, not now", () => {
    expect(PHASE_13_CREATED_AT_MS).toBe(Date.UTC(2026, 3, 16));
    expect(new Date(PHASE_13_CREATED_AT_MS).toISOString()).toBe(
      "2026-04-16T00:00:00.000Z",
    );
    expect(PHASE_13_CREATED_AT_MS).toBeLessThan(Date.now());
  });

  it("acting user is email-keyed", () => {
    expect(BACKFILL_USER_EMAIL).toBe("juan@neogranadina.org");
  });
});

// Version: v0.4.2
