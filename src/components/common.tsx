import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import type { FocusState } from "../core/types";
import { focusStateLabels } from "../core/labels";
import { formatDuration, formatPercentage } from "../core/formatters";

export const Panel = ({
  children,
  className = "",
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) => (
  <section className={`panel ${className}`} aria-label={ariaLabel}>
    {children}
  </section>
);

export const SectionHeader = ({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) => (
  <div className="section-header">
    <div>
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
    {action ? <div className="section-action">{action}</div> : null}
  </div>
);

export const IconButton = ({
  children,
  label,
  onClick,
  disabled,
  variant = "ghost",
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "ghost" | "primary" | "soft" | "danger";
}) => (
  <button className={`icon-button ${variant}`} type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
    {children}
  </button>
);

export const CommandButton = ({
  children,
  onClick,
  disabled,
  loading = false,
  loadingLabel = "处理中",
  variant = "soft",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  variant?: "soft" | "primary" | "danger" | "ghost";
}) => (
  <button
    aria-busy={loading || undefined}
    className={`command-button ${variant} ${loading ? "is-loading" : ""}`}
    type="button"
    onClick={onClick}
    disabled={disabled || loading}
  >
    {loading ? <><LoaderCircle className="button-spinner" size={15} /> {loadingLabel}</> : children}
  </button>
);

export const StateBadge = ({ state }: { state: FocusState }) => (
  <span className={`state-badge state-${state}`}>
    <span aria-hidden className="state-dot" />
    {focusStateLabels[state].title}
  </span>
);

export const DurationMetric = ({ label, seconds, total }: { label: string; seconds: number; total?: number }) => (
  <div className="metric-tile">
    <span>{label}</span>
    <strong>{formatDuration(seconds)}</strong>
    {total !== undefined ? <small>{formatPercentage(total > 0 ? seconds / total : 0)}</small> : null}
  </div>
);

export const EmptyState = ({ title, detail }: { title: string; detail?: string }) => (
  <div className="empty-state">
    <strong>{title}</strong>
    {detail ? <span>{detail}</span> : null}
  </div>
);
