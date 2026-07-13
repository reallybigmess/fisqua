/**
 * Description Section (cataloguing)
 *
 * This component is the collapsible section primitive for the cataloguing
 * description form. Pure presentation: receives a translated `title`
 * string and a completion-state flag from the parent (the parent
 * `description-form.tsx` resolves both via `tStd` and the
 * `SectionCompletion` aggregate).
 *
 * No i18n calls live here — by design: label resolution is the
 * parent's responsibility so per-standard label overrides flow
 * through one site (`tStd(t, "sections.<id>", standard)`) rather than
 * being split between parent and child.
 *
 * @version v0.4.2
 */

type DescriptionSectionProps = {
  title: string;
  isExpanded: boolean;
  isComplete: boolean;
  isDisabled?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
};

function ChevronRightIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function CompletionDot({ isComplete }: { isComplete: boolean }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        isComplete
          ? "bg-verdigris"
          : "border border-stone-200 bg-transparent"
      }`}
    />
  );
}

export function DescriptionSection({
  title,
  isExpanded,
  isComplete,
  isDisabled = false,
  onToggle,
  children,
}: DescriptionSectionProps) {
  return (
    <div
      className={`rounded-lg border ${ isExpanded ? "border-indigo" : "border-stone-200" } ${isDisabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      {/* Header */}
      <button
        type="button"
        className={`flex w-full items-center gap-2.5 p-4 text-left ${
          isDisabled ? "pointer-events-none" : ""
        }`}
        onClick={isDisabled ? undefined : onToggle}
        disabled={isDisabled}
      >
        <span
          className={
            isExpanded ? "text-indigo" : "text-stone-700"
          }
        >
          {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
        <span
          className={`flex-1 font-display text-lg font-semibold ${
            isExpanded ? "text-indigo" : "text-stone-700"
          }`}
        >
          {title}
        </span>
        {isDisabled && (
          <span className="text-stone-500">
            <LockIcon />
          </span>
        )}
        <CompletionDot isComplete={isComplete} />
      </button>

      {/* Collapsible body */}
      <div className="comments-collapse" data-open={isExpanded}>
        <div>
          <div className="px-4 pb-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

export { CompletionDot };

/* @version v0.4.2 */
