/**
 * Admin — authority detail two-column layout (shared primitives)
 *
 * The record-page redesign (spec §5, mockup 2026-07-11): the record's
 * own cards and the linked-descriptions worklist share the width in an
 * even 50–50 split on wide viewports. On narrow screens the columns
 * stack record-FIRST — the exact inverse of the buried single-column
 * layout this replaces. Both authority detail pages (entities, places)
 * share these primitives; the per-type field content stays in the
 * routes.
 *
 * @version v0.4.3
 */

export function TwoColumnDetail({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="mt-6 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* Source order = stacking order: the record renders first. */}
      <div className="min-w-0">{left}</div>
      <div className="min-w-0">{right}</div>
    </div>
  );
}

export function DetailCard({
  title,
  children,
  dimmed = false,
}: {
  title: string;
  children: React.ReactNode;
  dimmed?: boolean;
}) {
  return (
    <section
      className={`mb-4 rounded-lg border border-stone-200 bg-white px-4 py-3.5 ${
        dimmed ? "pointer-events-none opacity-55" : ""
      }`}
    >
      <h3 className="mb-2.5 text-11 font-bold uppercase tracking-[0.12em] text-stone-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Notes cards, shared by both record types' view mode. `notes` renders
 * as a plain card; `internalNotes` renders with the internal marking
 * (saffron rail + label) so it is never mistaken for published copy —
 * it never leaves the admin surface (excluded from the export
 * pipeline). Each card renders ONLY when its value is non-empty.
 */
export function NotesCards({
  notes,
  internalNotes,
  notesLabel,
  internalNotesLabel,
  internalBadge,
}: {
  notes: string | null | undefined;
  internalNotes: string | null | undefined;
  notesLabel: string;
  internalNotesLabel: string;
  internalBadge: string;
}) {
  const hasNotes = !!notes && notes.trim().length > 0;
  const hasInternal = !!internalNotes && internalNotes.trim().length > 0;
  if (!hasNotes && !hasInternal) return null;
  return (
    <>
      {hasNotes && (
        <DetailCard title={notesLabel}>
          <p className="whitespace-pre-wrap text-sm text-stone-700">{notes}</p>
        </DetailCard>
      )}
      {hasInternal && (
        <section className="mb-4 rounded-lg border border-saffron/40 bg-saffron-tint/40 px-4 py-3.5">
          <div className="mb-2.5 flex items-center gap-2">
            <h3 className="text-11 font-bold uppercase tracking-[0.12em] text-saffron-deep">
              {internalNotesLabel}
            </h3>
            <span className="rounded-full bg-saffron-tint px-2 py-0.5 text-10 font-semibold uppercase tracking-wide text-saffron-deep">
              {internalBadge}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-stone-700">
            {internalNotes}
          </p>
        </section>
      )}
    </>
  );
}

/**
 * Notes edit pair, shared by both record types' edit mode. Two plain
 * textareas; the internal one carries the internal marking on its
 * label. Uncontrolled (defaultValue) — the enclosing form reads them by
 * name on submit.
 */
export function NotesEditFields({
  notes,
  internalNotes,
  notesLabel,
  internalNotesLabel,
  internalBadge,
}: {
  notes: string | null | undefined;
  internalNotes: string | null | undefined;
  notesLabel: string;
  internalNotesLabel: string;
  internalBadge: string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label
          htmlFor="notes"
          className="mb-1 block text-xs font-medium text-indigo"
        >
          {notesLabel}
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={notes ?? ""}
          className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
        />
      </div>
      <div>
        <label
          htmlFor="internalNotes"
          className="mb-1 flex items-center gap-2 text-xs font-medium text-saffron-deep"
        >
          {internalNotesLabel}
          <span className="rounded-full bg-saffron-tint px-2 py-0.5 text-10 font-semibold uppercase tracking-wide text-saffron-deep">
            {internalBadge}
          </span>
        </label>
        <textarea
          id="internalNotes"
          name="internalNotes"
          rows={3}
          defaultValue={internalNotes ?? ""}
          className="w-full rounded-lg border border-saffron/40 px-3 py-2 text-sm text-stone-700 focus:border-saffron focus:outline-none focus:ring-1 focus:ring-saffron"
        />
      </div>
    </div>
  );
}

/** Name-variant chips, shared by both record types' Identity cards. */
export function VariantChips({ variants }: { variants: string[] }) {
  if (variants.length === 0) {
    return <p className="text-sm text-stone-700">{"—"}</p>;
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {variants.map((v, i) => (
        <span
          key={i}
          className="inline-block rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600"
        >
          {v}
        </span>
      ))}
    </div>
  );
}
