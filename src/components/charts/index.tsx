import { useId, type CSSProperties, type PointerEvent, type ReactNode, type SVGAttributes } from "react";
import type { UIStatus } from "../ui";
import { timeToProgress, type TimeDomain } from "./scale";

const polar = (cx: number, cy: number, radius: number, angle: number) => {
  const radians = ((angle - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
};

const arcPath = (cx: number, cy: number, radius: number, startAngle: number, endAngle: number) => {
  if (endAngle - startAngle >= 359.999) {
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`;
  }
  const start = polar(cx, cy, radius, endAngle);
  const end = polar(cx, cy, radius, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
};

export interface ChartFrameProps extends SVGAttributes<SVGSVGElement> {
  label: string;
  viewBox: string;
  children: ReactNode;
}

export const ChartFrame = ({ label, viewBox, children, className, ...props }: ChartFrameProps) => (
  <svg className={`fp-chart-frame ${className ?? ""}`} viewBox={viewBox} role="img" aria-label={label} {...props}>
    {children}
  </svg>
);

export interface HourlyBarDatum {
  id: string;
  label: string;
  focus: number;
  distracted: number;
}

export interface HourlyBarsProps {
  data: HourlyBarDatum[];
  label: string;
  maxValue?: number;
  className?: string;
  onHover?: (datum: HourlyBarDatum, event: PointerEvent<SVGGElement>) => void;
}

export const HourlyBars = ({ data, label, maxValue, className, onHover }: HourlyBarsProps) => {
  const ceiling = Math.max(1, maxValue ?? 0, ...data.map((datum) => datum.focus + datum.distracted));
  const step = 30;
  const plotHeight = 188;
  const baseline = 10 + plotHeight;
  const width = Math.max(step, data.length * step);
  return (
    <ChartFrame className={`fp-hourly-bars ${className ?? ""}`} label={label} viewBox={`0 0 ${width} 226`} preserveAspectRatio="none">
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <line className="grid-line" key={ratio} x1="0" x2={width} y1={10 + plotHeight * (1 - ratio)} y2={10 + plotHeight * (1 - ratio)} />
      ))}
      {data.map((datum, index) => {
        const total = datum.focus + datum.distracted;
        const totalHeight = Math.max(total > 0 ? 3 : 0, (total / ceiling) * plotHeight);
        const focusHeight = total > 0 ? totalHeight * (datum.focus / total) : 0;
        const distractedHeight = Math.max(0, totalHeight - focusHeight);
        const x = index * step + 7;
        return (
          <g
            className="activity-hour-slot"
            key={datum.id}
            onPointerEnter={(event) => onHover?.(datum, event)}
            onPointerMove={(event) => onHover?.(datum, event)}
            tabIndex={0}
          >
            <rect className="track" x={x} y="10" width="16" height={plotHeight} rx="5" />
            {distractedHeight > 0 ? <rect className="state-distracted" x={x} y={baseline - totalHeight} width="16" height={distractedHeight} rx="4" /> : null}
            {focusHeight > 0 ? <rect className="state-focus" x={x} y={baseline - focusHeight} width="16" height={focusHeight} rx="4" /> : null}
            <text x={x + 8} y={baseline + 18} textAnchor="middle">{datum.label}</text>
            <title>{`${datum.label}:00 · 日均 ${(total / 60).toFixed(1)} 分钟`}</title>
          </g>
        );
      })}
    </ChartFrame>
  );
};

export interface HeatmapCell {
  id: string;
  column: number;
  row: number;
  ratio: number;
  intensity: number;
  label: string;
  disabled?: boolean;
}

export interface HeatmapProps {
  cells: HeatmapCell[];
  columns: number;
  rows: number;
  label: string;
  className?: string;
  columnLabels?: string[];
  rowLabels?: string[];
  onHover?: (cell: HeatmapCell, event: PointerEvent<SVGRectElement>) => void;
}

export const Heatmap = ({ cells, columns, rows, label, className, columnLabels, rowLabels, onHover }: HeatmapProps) => {
  const size = 18;
  const gap = 5;
  const labelHeight = columnLabels?.length ? 22 : 0;
  const rowLabelWidth = rowLabels?.length ? 18 : 0;
  const width = rowLabelWidth + Math.max(size, columns * (size + gap) - gap);
  const height = labelHeight + Math.max(size, rows * (size + gap) - gap);
  return (
    <ChartFrame className={`fp-heatmap ${className ?? ""}`} label={label} viewBox={`0 0 ${width} ${height}`}>
      {columnLabels?.map((columnLabel, column) => (
        <text className="heatmap-column-label" key={`${columnLabel}-${column}`} x={rowLabelWidth + column * (size + gap) + size / 2} y="12" textAnchor="middle">
          {columnLabel}
        </text>
      ))}
      {rowLabels?.slice(0, rows).map((rowLabel, row) => (
        <text
          className="heatmap-row-label"
          key={`${rowLabel}-${row}`}
          x={rowLabelWidth - 5}
          y={labelHeight + row * (size + gap) + size / 2}
          dominantBaseline="middle"
          textAnchor="end"
        >
          {rowLabel}
        </text>
      ))}
      {cells.map((cell) => (
        <rect
          className={`heatmap-cell ${cell.intensity > 0 ? "has-activity" : ""} ${cell.disabled ? "is-empty" : ""}`}
          key={cell.id}
          x={rowLabelWidth + cell.column * (size + gap)}
          y={labelHeight + cell.row * (size + gap)}
          width={size}
          height={size}
          rx="4"
          onPointerEnter={cell.disabled ? undefined : (event) => onHover?.(cell, event)}
          onPointerMove={cell.disabled ? undefined : (event) => onHover?.(cell, event)}
          style={{ "--ratio": cell.ratio, "--intensity": cell.intensity } as CSSProperties}
          tabIndex={cell.disabled ? undefined : 0}
        >
          <title>{cell.label}</title>
        </rect>
      ))}
    </ChartFrame>
  );
};

export interface PieDatum {
  id: string;
  label: string;
  value: number;
  color: string;
  valueLabel?: string;
}

export interface FilledPieChartProps {
  data: PieDatum[];
  label: string;
  primaryValue?: ReactNode;
  primaryDetail?: ReactNode;
  compact?: boolean;
  className?: string;
}

export const FilledPieChart = ({ data, label, primaryValue, primaryDetail, compact, className }: FilledPieChartProps) => {
  const total = data.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const slices = data.filter((item) => item.value > 0);
  const primary = [...slices].sort((left, right) => right.value - left.value)[0];
  const radius = compact ? 64 : 72;
  const cx = 120;
  const cy = compact ? 95 : 102;
  let cursor = 0;
  const geometry = slices.map((item) => {
    const startAngle = cursor;
    const endAngle = cursor + (item.value / Math.max(total, 1)) * 360;
    cursor = endAngle;
    return { ...item, startAngle, endAngle, ratio: item.value / Math.max(total, 1) };
  });
  const labelled = geometry.filter((item) => item.id !== primary?.id && item.ratio >= 0.08);
  const filterID = useId().replaceAll(":", "");

  return (
    <figure className={`fp-filled-pie ${compact ? "is-compact" : ""} ${className ?? ""}`}>
      <svg viewBox="0 0 240 220" role="img" aria-label={label}>
        <defs>
          <filter id={filterID} x="-30%" y="-30%" width="160%" height="180%">
            <feDropShadow dx="0" dy="8" stdDeviation="7" floodColor="var(--text-primary)" floodOpacity="0.16" />
          </filter>
        </defs>
        <g className="fp-pie-depth" aria-hidden transform="translate(0 10) scale(1 .93)" style={{ "--pie-origin-x": `${cx}px`, "--pie-origin-y": `${cy}px` } as CSSProperties}>
          {geometry.map((item) => <path key={item.id} d={arcPath(cx, cy, radius, item.startAngle, item.endAngle)} fill={item.color} />)}
        </g>
        <g className="fp-pie-face" filter={`url(#${filterID})`}>
          {geometry.map((item) => <path key={item.id} d={arcPath(cx, cy, radius, item.startAngle, item.endAngle)} fill={item.color} stroke="var(--card)" strokeOpacity="0.72" strokeWidth="1.4" />)}
        </g>
        {total === 0 ? <text className="fp-pie-empty" x={cx} y={cy + 4} textAnchor="middle">暂无</text> : (
          <g className="fp-pie-primary" aria-hidden>
            <text x={cx} y={cy - 13} textAnchor="middle">{primary?.label}</text>
            <text className="value" x={cx} y={cy + 13} textAnchor="middle">{primaryValue}</text>
            <text x={cx} y={cy + 31} textAnchor="middle">{primaryDetail}</text>
          </g>
        )}
        {!compact ? labelled.map((item) => {
          const mid = (item.startAngle + item.endAngle) / 2;
          const inner = polar(cx, cy, radius + 3, mid);
          const outer = polar(cx, cy, radius + 22, mid);
          const onRight = outer.x >= cx;
          const endX = onRight ? 226 : 14;
          return (
            <g className="fp-pie-callout-svg" key={item.id}>
              <polyline points={`${inner.x},${inner.y} ${outer.x},${outer.y} ${endX},${outer.y}`} fill="none" stroke={item.color} />
              <text x={onRight ? endX : endX} y={outer.y - 4} textAnchor={onRight ? "end" : "start"}>{item.label}</text>
              <text className="detail" x={endX} y={outer.y + 10} textAnchor={onRight ? "end" : "start"}>{item.valueLabel}</text>
            </g>
          );
        }) : null}
      </svg>
    </figure>
  );
};

export interface ProgressRingProps extends SVGAttributes<SVGSVGElement> {
  value: number;
  label: string;
  status?: UIStatus;
  children?: ReactNode;
}

export const ProgressRing = ({ value, label, status = "success", children, className, ...props }: ProgressRingProps) => {
  const progress = Math.max(0, Math.min(1, value));
  const circumference = 2 * Math.PI * 20;
  return (
    <svg className={`fp-progress-ring is-${status} ${className ?? ""}`} viewBox="0 0 48 48" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} {...props}>
      <circle className="track" cx="24" cy="24" r="20" />
      <circle className="value" cx="24" cy="24" r="20" pathLength={circumference} style={{ "--ring-offset": 1 - progress } as CSSProperties} />
      {children}
    </svg>
  );
};

export interface TimelineSegment {
  id: string;
  start: number;
  end: number;
  status: UIStatus;
  label?: string;
}

export const StatusTimeline = ({ segments, domain, label, className }: { segments: TimelineSegment[]; domain: TimeDomain; label: string; className?: string }) => (
  <svg className={`fp-status-timeline ${className ?? ""}`} viewBox="0 0 1000 32" preserveAspectRatio="none" role="img" aria-label={label}>
    <rect className="track" x="0" y="7" width="1000" height="18" rx="9" />
    {segments.map((segment) => {
      const start = timeToProgress(segment.start, domain) * 1000;
      const end = timeToProgress(segment.end, domain) * 1000;
      return <rect className={`is-${segment.status}`} key={segment.id} x={start} y="7" width={Math.max(2, end - start)} height="18" rx="7" />;
    })}
  </svg>
);

export interface InputColumn {
  id: string;
  progress: number;
  keyboard: number;
  pointer: number;
}

export const InputColumns = ({ columns, label, className }: { columns: InputColumn[]; label: string; className?: string }) => {
  const max = Math.max(1, ...columns.map((column) => column.keyboard + column.pointer));
  return (
    <svg className={`fp-input-columns ${className ?? ""}`} viewBox="0 0 1000 80" preserveAspectRatio="none" role="img" aria-label={label}>
      {columns.map((column) => {
        const keyboardHeight = (column.keyboard / max) * 66;
        const pointerHeight = (column.pointer / max) * 66;
        return (
          <g key={column.id} transform={`translate(${column.progress * 1000} 0)`}>
            <rect className="pointer" x="-3" y={72 - pointerHeight} width="6" height={pointerHeight} rx="2" />
            <rect className="keyboard" x="-3" y={72 - pointerHeight - keyboardHeight} width="6" height={keyboardHeight} rx="2" />
          </g>
        );
      })}
    </svg>
  );
};
