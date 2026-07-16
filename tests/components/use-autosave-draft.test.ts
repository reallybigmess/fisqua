/**
 * Tests — admin autosave-draft pure helpers
 *
 * This suite pins the two pure helpers extracted out of the previously
 * three-way-duplicated autosave machinery in the admin detail editors
 * (`entities.$id`, `places.$id`, `descriptions.$id`), now living in
 * `app/components/admin/use-autosave-draft.ts`:
 *
 *   - `buildDraftSnapshot` — captures every non-`_`-prefixed form field
 *     into a flat record; `_action` / `_updatedAt` / `_force` control
 *     fields are excluded. This is the exact snapshot the debounced
 *     autosave POSTs to the `drafts` table.
 *   - `deriveDraftStatus` — maps fetcher `state` + returned `data` to
 *     the saving/saved/null status-pill value.
 *
 * No React rendering, no jsdom -- both helpers are pure. Same
 * Workers-pool pure-function pattern as
 * `tests/components/save-status.test.tsx`.
 *
 * @version v0.4.1
 */
import { describe, it, expect } from "vitest";
import {
  buildDraftSnapshot,
  deriveDraftStatus,
} from "../../app/components/admin/use-autosave-draft";

describe("buildDraftSnapshot", () => {
  it("captures ordinary (non-underscore) fields", () => {
    const fd = new FormData();
    fd.set("displayName", "Bolívar");
    fd.set("history", "founded 1810");
    expect(buildDraftSnapshot(fd)).toEqual({
      displayName: "Bolívar",
      history: "founded 1810",
    });
  });

  it("excludes every underscore-prefixed control field", () => {
    const fd = new FormData();
    fd.set("_action", "update");
    fd.set("_updatedAt", "123456");
    fd.set("_force", "true");
    fd.set("title", "kept");
    expect(buildDraftSnapshot(fd)).toEqual({ title: "kept" });
  });

  it("returns an empty object when only control fields are present", () => {
    const fd = new FormData();
    fd.set("_action", "autosave");
    fd.set("_updatedAt", "1");
    expect(buildDraftSnapshot(fd)).toEqual({});
  });

  it("keeps the empty string value for a present, empty field", () => {
    const fd = new FormData();
    fd.set("surname", "");
    expect(buildDraftSnapshot(fd)).toEqual({ surname: "" });
  });
});

describe("deriveDraftStatus", () => {
  it("returns 'saving' while the fetcher is submitting", () => {
    expect(deriveDraftStatus("submitting", undefined)).toBe("saving");
  });

  it("prefers 'saving' even when prior data carried an autosaved flag", () => {
    expect(deriveDraftStatus("submitting", { autosaved: true })).toBe("saving");
  });

  it("returns 'saved' once a settled response carries the autosaved flag", () => {
    expect(deriveDraftStatus("idle", { ok: true, autosaved: true })).toBe(
      "saved",
    );
  });

  it("returns null when idle with no data", () => {
    expect(deriveDraftStatus("idle", undefined)).toBeNull();
  });

  it("returns null when idle and data lacks the autosaved flag", () => {
    expect(deriveDraftStatus("idle", { ok: true, message: "updated" })).toBeNull();
  });

  it("returns null while loading with no autosaved data", () => {
    expect(deriveDraftStatus("loading", undefined)).toBeNull();
  });
});
