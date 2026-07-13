/**
 * Collapsible Section
 *
 * This component is the generic accordion wrapper for grouping dense
 * admin content into expandable panels. Keeps an internal open/closed
 * state unless an explicit controlled pair is passed, and emits a summary
 * line when collapsed so the caller never loses scanning context.
 *
 * @version v0.4.2
 */

import { useState, useId } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const id = useId();
  const headingId = `${id}-heading`;
  const contentId = `${id}-content`;

  return (
    <div className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-stone-200">
      <button
        type="button"
        className="flex w-full items-center justify-between py-4"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span
          id={headingId}
          className="text-sm font-semibold uppercase tracking-wider text-stone-500"
        >
          {title}
        </span>
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-stone-500" />
        ) : (
          <ChevronDown className="h-4 w-4 text-stone-500" />
        )}
      </button>
      {isOpen && (
        <div
          id={contentId}
          role="region"
          aria-labelledby={headingId}
          className="pb-4"
        >
          {children}
        </div>
      )}
    </div>
  );
}
