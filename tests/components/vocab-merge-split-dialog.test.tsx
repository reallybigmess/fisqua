/**
 * Tests — shared admin MergeDialog / SplitDialog form contract
 *
 * This suite pins the submitted-form contract of the shared admin
 * `MergeDialog` and `SplitDialog` components that the vocabulary
 * functions detail page consolidates onto (audit items 4 + 9, Path B).
 * The dialogs are namespace-agnostic: they resolve every label against
 * whatever `i18nNamespace` the consumer passes, and they emit a
 * `<Form method="post">` whose hidden inputs are the wire contract the
 * server action reads — `_action` = "merge"/"split", `targetId` (merge),
 * `linkIds` (JSON array), and `newName` (split, once the name-field
 * extension exists).
 *
 * Rendering strategy — `renderToStaticMarkup` under the Workers pool,
 * exactly as `tests/routes/landing.test.tsx` renders the landing route.
 * This codebase deliberately does NOT pull in `@testing-library/react`
 * + jsdom (see the `tests/components/*.test.tsx` convention), so the
 * dialogs are rendered to a static HTML string and asserted by
 * substring. Static markup runs the render body and initial `useState`
 * but NOT `useEffect` and NOT user interaction, so only the initially
 * reachable view is asserted here:
 *
 *   - SplitDialog renders its submit `<Form>` unconditionally, so the
 *     full split field contract (`_action`, `linkIds`, `newName`) is
 *     pinned here.
 *   - MergeDialog's submit `<Form>` lives behind step 2 (target
 *     selected), which requires interaction and is therefore NOT
 *     reachable in static markup. Only the step-1 shell (title, search,
 *     cancel) is asserted here; the merge submit contract (`_action` =
 *     "merge", `targetId`, `linkIds`) is pinned end-to-end at the
 *     action level in `tests/admin/vocab-merge-split-action.test.ts`.
 *
 * The i18n resources are an inline bundle owned by this test (not the
 * app locale files) so the component contract is verified independently
 * of the locale wiring — the vocab namespace keys are exercised by the
 * completeness suite and the route swap, not here.
 *
 * @version v0.4.1
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { I18nextProvider } from "react-i18next";
import { createRoutesStub } from "react-router";
import i18next from "i18next";
import { MergeDialog } from "../../app/components/admin/merge-dialog";
import { SplitDialog } from "../../app/components/admin/split-dialog";

const NS = "vocabularies";

// Inline label bundle — the camelCase key set the shared dialogs
// resolve against `i18nNamespace`. Values are arbitrary sentinels the
// assertions match on; they are not the app's real strings.
const LABELS = {
  mergeTitle: "MERGE_TITLE",
  mergeSearch: "MERGE_SEARCH",
  mergeReassignTitle: "MERGE_REASSIGN_TITLE",
  mergeReassignSubtitle: "{{name}} has {{count}} links",
  mergeConfirm: "MERGE_CONFIRM",
  mergeCancel: "MERGE_CANCEL",
  splitTitle: "SPLIT_TITLE",
  splitSubtitle: "SPLIT_SUBTITLE {{name}}",
  splitConfirm: "SPLIT_CONFIRM",
  splitCancel: "SPLIT_CANCEL",
  splitNameLabel: "SPLIT_NAME_LABEL",
  splitNamePlaceholder: "SPLIT_NAME_PLACEHOLDER",
  loadMore: "LOAD_MORE",
  selectAll: "SELECT_ALL",
  deselectAll: "DESELECT_ALL",
};

async function makeI18n() {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: "en",
    fallbackLng: "en",
    defaultNS: NS,
    ns: [NS],
    resources: { en: { [NS]: LABELS } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return inst;
}

// The shared dialogs render react-router's <Form>, which needs a data-
// router context. `createRoutesStub` provides one; the dialog is the
// element rendered at "/".
async function render(node: React.ReactElement): Promise<string> {
  const inst = await makeI18n();
  const Stub = createRoutesStub([{ path: "/", Component: () => node }]);
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: inst }, React.createElement(Stub)),
  );
}

const LINKS = [
  { id: "e1", descriptionTitle: "Entity One", role: "person" },
  { id: "e2", descriptionTitle: "Entity Two", role: "family" },
];

describe("SplitDialog form contract", () => {
  it("renders nothing when isOpen=false", async () => {
    const props: any = {
      isOpen: false,
      onClose: () => {},
      sourceId: "src-1",
      sourceName: "Notario",
      entityType: "vocabulary",
      links: LINKS,
      i18nNamespace: NS,
    };
    const html = await render(<SplitDialog {...props} />);
    expect(html).toBe("");
  });

  it("submits _action=split with a linkIds JSON array", async () => {
    const props: any = {
      isOpen: true,
      onClose: () => {},
      sourceId: "src-1",
      sourceName: "Notario",
      entityType: "vocabulary",
      links: LINKS,
      i18nNamespace: NS,
    };
    const html = await render(<SplitDialog {...props} />);
    expect(html).toContain('name="_action"');
    expect(html).toContain('value="split"');
    expect(html).toContain('name="linkIds"');
    // defaultChecked=false on split → nothing selected initially → "[]"
    expect(html).toContain('value="[]"');
    expect(html).toContain("SPLIT_CONFIRM");
    expect(html).toContain("SPLIT_CANCEL");
    expect(html).toContain("SPLIT_TITLE");
  });

  it("renders the reassignment list rows for each link", async () => {
    const props: any = {
      isOpen: true,
      onClose: () => {},
      sourceId: "src-1",
      sourceName: "Notario",
      entityType: "vocabulary",
      links: LINKS,
      i18nNamespace: NS,
    };
    const html = await render(<SplitDialog {...props} />);
    expect(html).toContain("Entity One");
    expect(html).toContain("Entity Two");
  });

  it("does NOT emit a newName field when splitNameField is absent", async () => {
    const props: any = {
      isOpen: true,
      onClose: () => {},
      sourceId: "src-1",
      sourceName: "Notario",
      entityType: "vocabulary",
      links: LINKS,
      i18nNamespace: NS,
    };
    const html = await render(<SplitDialog {...props} />);
    expect(html).not.toContain('name="newName"');
    // With no name-field gate, the confirm button carries no disabled
    // attribute (the `disabled:` utility classes are always present).
    expect(html).not.toContain('disabled=""');
  });

  it("renders a required name field and submits newName when splitNameField is set", async () => {
    const props: any = {
      isOpen: true,
      onClose: () => {},
      sourceId: "src-1",
      sourceName: "Notario",
      entityType: "vocabulary",
      links: LINKS,
      i18nNamespace: NS,
      splitNameField: {
        label: "SPLIT_NAME_LABEL",
        placeholder: "SPLIT_NAME_PLACEHOLDER",
      },
    };
    const html = await render(<SplitDialog {...props} />);
    // Labelled, required text input for the new term name.
    expect(html).toContain("SPLIT_NAME_LABEL");
    expect(html).toContain('placeholder="SPLIT_NAME_PLACEHOLDER"');
    expect(html).toContain("required");
    // Submits the name as a hidden newName field inside the Form.
    expect(html).toContain('name="newName"');
    // Confirm is disabled while the name is empty (initial state).
    expect(html).toContain('disabled=""');
    // Split contract still intact alongside the new field.
    expect(html).toContain('name="_action"');
    expect(html).toContain('value="split"');
    expect(html).toContain('name="linkIds"');
  });
});

describe("MergeDialog step-1 shell", () => {
  it("renders nothing when isOpen=false", async () => {
    const props: any = {
      isOpen: false,
      onClose: () => {},
      sourceId: "src-1",
      sourceName: "Notario",
      entityType: "vocabulary",
      links: LINKS,
      searchEndpoint: "/admin/vocabularies/functions",
      i18nNamespace: NS,
    };
    const html = await render(<MergeDialog {...props} />);
    expect(html).toBe("");
  });

  it("renders the merge title, search box, and cancel on step 1", async () => {
    const props: any = {
      isOpen: true,
      onClose: () => {},
      sourceId: "src-1",
      sourceName: "Notario",
      entityType: "vocabulary",
      links: LINKS,
      searchEndpoint: "/admin/vocabularies/functions",
      i18nNamespace: NS,
    };
    const html = await render(<MergeDialog {...props} />);
    expect(html).toContain("MERGE_TITLE");
    expect(html).toContain('placeholder="MERGE_SEARCH"');
    expect(html).toContain("MERGE_CANCEL");
  });
});
