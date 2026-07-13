/**
 * Vocabulary Status Badge
 *
 * This badge is the colour-coded status pill for vocabulary-term rows:
 * active, draft, pending review, rejected, or deprecated. Keeps the colour
 * map in one place so every vocabularies admin surface shows the same
 * visual vocabulary.
 *
 * @version v0.4.2
 */

import { useTranslation } from "react-i18next";

const STATUS_STYLES: Record<string, string> = {
  approved: "bg-verdigris-tint text-verdigris-deep",
  proposed: "bg-saffron-tint text-saffron-deep",
  deprecated: "bg-stone-100 text-stone-600",
};

interface VocabularyStatusBadgeProps {
  status: "approved" | "proposed" | "deprecated";
}

export function VocabularyStatusBadge({ status }: VocabularyStatusBadgeProps) {
  const { t } = useTranslation("vocabularies");
  const style = STATUS_STYLES[status] ?? "";
  const label = t(`status_${status}`);

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-sans text-11 font-semibold uppercase tracking-[0.02em] ${style}`}
    >
      {label}
    </span>
  );
}
