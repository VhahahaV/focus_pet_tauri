import {
  Children,
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
} from "react";
import { Check, Minus, Plus } from "lucide-react";

export type UIStatus = "focus" | "distracted" | "success" | "away" | "pet" | "privacy" | "warning" | "error" | "neutral";
export type GlassRole = "data" | "control" | "badge" | "button" | "hero" | "stage" | "menu";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");
const statusClass = (status: UIStatus) => `is-${status}`;

export interface GlassSurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "section" | "article" | "aside";
  roleType?: GlassRole;
  status?: UIStatus;
  selected?: boolean;
}

export const GlassSurface = forwardRef(function GlassSurface(
  { as: Element = "div", roleType = "data", status = "neutral", selected, className, ...props }: GlassSurfaceProps,
  ref: Ref<HTMLElement>,
) {
  return (
    <Element
      ref={ref as never}
      className={cx("fp-glass", statusClass(status), className)}
      data-role={roleType}
      data-selected={selected || undefined}
      {...props}
    />
  );
});

export const Card = ({ className, status = "neutral", ...props }: GlassSurfaceProps) => (
  <GlassSurface as="section" roleType="data" status={status} className={cx("fp-card", className)} {...props} />
);

export const SemanticCard = ({ className, status = "focus", ...props }: GlassSurfaceProps) => (
  <GlassSurface as="section" roleType="hero" status={status} className={cx("fp-semantic-card", className)} {...props} />
);

export const InsetCard = ({ as: Element = "div", status = "neutral", selected, className, ...props }: GlassSurfaceProps) => (
  <Element className={cx("fp-inset-card", statusClass(status), className)} data-selected={selected || undefined} {...props} />
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  status?: UIStatus;
  compact?: boolean;
  icon?: ReactNode;
}

export const Badge = ({ status = "neutral", compact, icon, className, children, ...props }: BadgeProps) => (
  <GlassSurface
    as="div"
    roleType="badge"
    status={status}
    className={cx("fp-badge", className)}
    data-compact={compact || undefined}
    {...props}
  >
    {icon}
    {children}
  </GlassSurface>
);

export interface FPButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  status?: UIStatus;
  size?: "regular" | "small";
}

const ButtonBase = forwardRef(function ButtonBase(
  { status = "focus", size = "regular", className, children, ...props }: FPButtonProps & { variant: "primary" | "soft" },
  ref: Ref<HTMLButtonElement>,
) {
  const { variant, ...buttonProps } = props;
  return (
    <button
      ref={ref}
      className={cx("fp-glass", "fp-button", statusClass(status), className)}
      data-role="button"
      data-size={size === "small" ? "small" : undefined}
      data-variant={variant}
      {...buttonProps}
    >
      {children}
    </button>
  );
});

export const PrimaryButton = forwardRef(function PrimaryButton(props: FPButtonProps, ref: Ref<HTMLButtonElement>) {
  return <ButtonBase ref={ref} variant="primary" {...props} />;
});

export const SoftButton = forwardRef(function SoftButton(props: FPButtonProps, ref: Ref<HTMLButtonElement>) {
  return <ButtonBase ref={ref} variant="soft" {...props} />;
});

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string | number> {
  label: string;
  value: T;
  options: Array<SegmentOption<T>>;
  onChange: (value: T) => void;
  status?: UIStatus;
  className?: string;
}

export function SegmentedControl<T extends string | number>({
  label,
  value,
  options,
  onChange,
  status = "focus",
  className,
}: SegmentedControlProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const style = {
    "--segment-count": options.length,
  } as CSSProperties;

  const move = (origin: number, delta: number) => {
    if (options.length < 2) return;
    for (let offset = 1; offset <= options.length; offset += 1) {
      const next = (origin + delta * offset + options.length) % options.length;
      if (!options[next]?.disabled) {
        onChange(options[next].value);
        buttons.current[next]?.focus();
        return;
      }
    }
  };

  return (
    <div className={cx("fp-segmented-control", statusClass(status), className)} role="radiogroup" aria-label={label} style={style}>
      {options.map((option, index) => (
        <button
          ref={(node) => { buttons.current[index] = node; }}
          className="fp-segmented-option"
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index, -1);
            } else if (event.key === "Home") {
              event.preventDefault();
              move(-1, 1);
            } else if (event.key === "End") {
              event.preventDefault();
              move(0, -1);
            }
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface TogglePillProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  status?: UIStatus;
}

export const TogglePill = ({ checked, onCheckedChange, status = "focus", className, children, ...props }: TogglePillProps) => (
  <button
    type="button"
    className={cx("fp-toggle-pill", statusClass(status), className)}
    aria-pressed={checked}
    onClick={() => onCheckedChange(!checked)}
    {...props}
  >
    <span className="fp-toggle-indicator" aria-hidden>{checked ? <Check size={11} strokeWidth={3} /> : null}</span>
    {children}
  </button>
);

export interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  status?: UIStatus;
  onChange: (value: number) => void;
  className?: string;
}

export const Stepper = ({ label, value, min, max, step = 1, suffix = "", status = "focus", onChange, className }: StepperProps) => {
  const repeatTimer = useRef<number | null>(null);
  const clearRepeat = () => {
    if (repeatTimer.current !== null) window.clearInterval(repeatTimer.current);
    repeatTimer.current = null;
  };
  useEffect(() => clearRepeat, []);
  const commit = (delta: number) => onChange(Math.min(max, Math.max(min, value + delta)));
  const beginRepeat = (delta: number) => {
    clearRepeat();
    repeatTimer.current = window.setInterval(() => commit(delta), 140);
  };

  return (
    <div className={cx("fp-stepper", statusClass(status), className)} role="group" aria-label={`${label} ${value}${suffix}`}>
      <span className="fp-stepper-label">{label}</span>
      <strong className="fp-value-chip" aria-live="polite">{value}{suffix}</strong>
      <div className="fp-stepper-actions">
        <button type="button" aria-label={`${label} 减少`} disabled={value <= min} onClick={() => commit(-step)} onPointerDown={() => beginRepeat(-step)} onPointerUp={clearRepeat} onPointerLeave={clearRepeat}><Minus size={13} /></button>
        <button type="button" aria-label={`${label} 增加`} disabled={value >= max} onClick={() => commit(step)} onPointerDown={() => beginRepeat(step)} onPointerUp={clearRepeat} onPointerLeave={clearRepeat}><Plus size={13} /></button>
      </div>
    </div>
  );
};

export interface SliderRowProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  status?: UIStatus;
  onChange: (value: number) => void;
}

export const SliderRow = ({ label, value, min, max, suffix = "", status = "focus", className, onChange, ...props }: SliderRowProps) => {
  const progress = ((value - min) / Math.max(1, max - min)) * 100;
  return (
    <div className={cx("fp-slider-row", statusClass(status), className)} style={{ "--slider-progress": `${progress}%` } as CSSProperties}>
      <label htmlFor={props.id}>{label}</label>
      <input type="range" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.currentTarget.value))} {...props} />
      <output className="fp-value-chip">{value}{suffix}</output>
    </div>
  );
};

export interface MetricTileProps extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode;
  value: ReactNode;
  label: ReactNode;
  status?: UIStatus;
}

export const MetricTile = ({ icon, value, label, status = "focus", className, ...props }: MetricTileProps) => (
  <InsetCard className={cx("fp-metric-tile", className)} status={status} {...props}>
    {icon ? <span className="fp-metric-icon">{icon}</span> : null}
    <span className="fp-metric-copy"><strong>{value}</strong><small>{label}</small></span>
  </InsetCard>
);

export interface MiniMeterProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
  status?: UIStatus;
  label?: string;
}

export const MiniMeter = ({ value, max = 1, status = "focus", label, className, ...props }: MiniMeterProps) => {
  const progress = Math.max(0, Math.min(100, (value / Math.max(max, 1)) * 100));
  return (
    <div className={cx("fp-mini-meter", statusClass(status), className)} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} {...props}>
      <span style={{ "--meter-progress": `${progress}%` } as CSSProperties} />
    </div>
  );
};

export const HoverCard = ({ status = "neutral", className, ...props }: GlassSurfaceProps) => (
  <GlassSurface roleType="menu" status={status} className={cx("fp-hover-card", className)} {...props} />
);

export const PrimitiveGroup = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={className} {...props}>{Children.map(children, (child) => child)}</div>
);
