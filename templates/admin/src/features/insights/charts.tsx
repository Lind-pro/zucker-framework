import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDay, niceTicks } from './format';

/**
 * Inline SVG charts for the insights page (no chart dependency). Marks follow one spec: 2px lines,
 * columns at most 24px wide with a 4px rounded data end, hairline solid gridlines, end dots with a
 * 2px surface ring, a single y axis, a legend for two or more series, text in text tokens only.
 * Every chart has a table equivalent (`SeriesTable`), which is also the accessible reading.
 *
 * Series colours are the validated categorical slots (light and dark steps), assigned in fixed
 * order by the caller so a series keeps its colour when others are absent.
 */

export const SERIES_SLOTS = 4;
/** Validated against the admin card surfaces (#ffffff light, #0f172a dark). */
const PALETTE_CSS = `
.insights-viz { --insights-s1: #2a78d6; --insights-s2: #eb6834; --insights-s3: #1baf7a; --insights-s4: #eda100; }
.dark .insights-viz { --insights-s1: #3987e5; --insights-s2: #d95926; --insights-s3: #199e70; --insights-s4: #c98500; }
`;
export const seriesColor = (slot: number) => `var(--insights-s${(slot % SERIES_SLOTS) + 1})`;

/** Mount once per page: defines the palette variables for `.insights-viz` in both themes. */
export function ChartPalette() {
  return <style>{PALETTE_CSS}</style>;
}

export interface ChartSeries {
  key: string;
  label: string;
  /** Palette slot (fixed per entity, never by rank). */
  slot: number;
  /** One value per date, for drawing. */
  values: number[];
  /** Exact display text per date (money keeps the server's decimal string). */
  display: string[];
}

const HEIGHT = 220;
const MARGIN = { top: 12, right: 16, bottom: 28, left: 56 };

function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Up to `max` evenly spaced indexes, always including the first and last. */
function labelIndexes(count: number, max: number): number[] {
  if (count <= max) return Array.from({ length: count }, (_, index) => index);
  const step = (count - 1) / (max - 1);
  return [...new Set(Array.from({ length: max }, (_, index) => Math.round(index * step)))];
}

export function Legend({ series }: { series: Pick<ChartSeries, 'key' | 'label' | 'slot'>[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((entry) => (
        <li key={entry.key} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block rounded-full" style={{ width: 12, height: 2, background: seriesColor(entry.slot) }} />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

function Tooltip({ x, width, date, rows, locale }: { x: number; width: number; date: string; rows: Array<{ key: string; label: string; slot: number; text: string }>; locale: string }) {
  const left = x > width / 2;
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-2 z-10 min-w-32 rounded-md border bg-card px-3 py-2 text-xs shadow-sm"
      style={left ? { right: width - x + 12 } : { left: x + 12 }}
    >
      <p className="font-medium text-foreground">{formatDay(date, locale)}</p>
      {rows.map((row) => (
        <p key={row.key} className="mt-1 flex items-center justify-between gap-3 text-muted-foreground">
          <span className="flex items-center gap-1.5">
            {rows.length > 1 && <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: seriesColor(row.slot) }} />}
            {row.label}
          </span>
          <span className="font-medium tabular-nums text-foreground">{row.text}</span>
        </p>
      ))}
    </div>
  );
}

interface Frame { width: number; plotWidth: number; plotHeight: number; ticks: number[]; y: (value: number) => number }
function frame(width: number, max: number, integer: boolean): Frame {
  const ticks = niceTicks(max, 4, integer), top = ticks[ticks.length - 1] || 1;
  const plotWidth = Math.max(40, width - MARGIN.left - MARGIN.right), plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  return { width, plotWidth, plotHeight, ticks, y: (value) => MARGIN.top + plotHeight - (Math.max(0, value) / top) * plotHeight };
}

function Axes({ f, dates, x, locale, formatTick }: { f: Frame; dates: string[]; x: (index: number) => number; locale: string; formatTick: (value: number) => string }) {
  const maxLabels = Math.max(2, Math.floor(f.plotWidth / 72));
  return (
    <g className="text-[11px]" fill="currentColor">
      {f.ticks.map((tick) => (
        <g key={tick}>
          <line x1={MARGIN.left} x2={MARGIN.left + f.plotWidth} y1={f.y(tick)} y2={f.y(tick)} stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges" />
          <text x={MARGIN.left - 8} y={f.y(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground tabular-nums">{formatTick(tick)}</text>
        </g>
      ))}
      {labelIndexes(dates.length, maxLabels).map((index) => (
        <text key={dates[index]} x={x(index)} y={HEIGHT - 8} textAnchor={dates.length === 1 ? 'middle' : index === 0 ? 'start' : index === dates.length - 1 ? 'end' : 'middle'}
          className="fill-muted-foreground">
          {formatDay(dates[index]!, locale)}
        </text>
      ))}
    </g>
  );
}

/** Daily lines (one per series) with a crosshair tooltip; a single series gets a 10% area wash. */
export function LineChart({ label, dates, series, locale, formatTick, integer = false }: {
  label: string; dates: string[]; series: ChartSeries[]; locale: string; formatTick: (value: number) => string; integer?: boolean;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const f = frame(width, Math.max(0, ...series.flatMap((entry) => entry.values)), integer);
  const x = (index: number) => MARGIN.left + (dates.length <= 1 ? f.plotWidth / 2 : (index / (dates.length - 1)) * f.plotWidth);
  const path = (values: number[]) => values.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${f.y(value).toFixed(1)}`).join('');
  const baseline = f.y(0), last = dates.length - 1;
  function onMove(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    setHover(Math.min(last, Math.max(0, Math.round(ratio * last))));
  }
  return (
    <div ref={ref} className="insights-viz relative min-w-0">
      <Legend series={series} />
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={label} className="block max-w-full overflow-visible text-foreground">
        <Axes f={f} dates={dates} x={x} locale={locale} formatTick={formatTick} />
        {series.length === 1 && dates.length > 1 && (
          <path d={`${path(series[0]!.values)}L${x(last)},${baseline}L${x(0)},${baseline}Z`} fill={seriesColor(series[0]!.slot)} fillOpacity={0.1} />
        )}
        {series.map((entry) => (
          <g key={entry.key} data-series={entry.key}>
            {dates.length > 1 && <path d={path(entry.values)} fill="none" stroke={seriesColor(entry.slot)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
            <circle cx={x(last)} cy={f.y(entry.values[last] ?? 0)} r={4} fill={seriesColor(entry.slot)} stroke="var(--card)" strokeWidth={2} />
          </g>
        ))}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={MARGIN.top} y2={baseline} stroke="var(--muted-foreground)" strokeWidth={1} opacity={0.5} />
            {series.map((entry) => (
              <circle key={entry.key} cx={x(hover)} cy={f.y(entry.values[hover] ?? 0)} r={4} fill={seriesColor(entry.slot)} stroke="var(--card)" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect x={MARGIN.left - 8} y={0} width={f.plotWidth + 16} height={HEIGHT - MARGIN.bottom + 8} fill="transparent"
          onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && dates[hover] && (
        <Tooltip x={x(hover)} width={width} date={dates[hover]} locale={locale}
          rows={series.map((entry) => ({ key: entry.key, label: entry.label, slot: entry.slot, text: entry.display[hover] ?? '' }))} />
      )}
    </div>
  );
}

/** Daily columns of one series (<=24px, 4px rounded top, square at the baseline) with a per-column tooltip. */
export function ColumnChart({ label, dates, series, locale, formatTick, integer = true }: {
  label: string; dates: string[]; series: ChartSeries; locale: string; formatTick: (value: number) => string; integer?: boolean;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const f = frame(width, Math.max(0, ...series.values), integer);
  const band = f.plotWidth / Math.max(1, dates.length);
  const barWidth = Math.max(1, Math.min(24, band - 2));
  const x = (index: number) => MARGIN.left + band * index + band / 2;
  const baseline = f.y(0);
  const column = (index: number, value: number) => {
    const top = f.y(value), height = baseline - top, left = x(index) - barWidth / 2;
    if (height <= 0) return '';
    const radius = Math.min(4, barWidth / 2, height);
    return `M${left},${baseline}V${top + radius}Q${left},${top} ${left + radius},${top}H${left + barWidth - radius}Q${left + barWidth},${top} ${left + barWidth},${top + radius}V${baseline}Z`;
  };
  return (
    <div ref={ref} className="insights-viz relative min-w-0">
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={label} className="block max-w-full overflow-visible text-foreground">
        <Axes f={f} dates={dates} x={x} locale={locale} formatTick={formatTick} />
        {series.values.map((value, index) => (
          <path key={dates[index]} d={column(index, value)} fill={seriesColor(series.slot)} opacity={hover === null || hover === index ? 1 : 0.55} />
        ))}
        {dates.map((date, index) => (
          <rect key={date} x={MARGIN.left + band * index} y={MARGIN.top} width={band} height={f.plotHeight} fill="transparent"
            onPointerEnter={() => setHover(index)} onPointerDown={() => setHover(index)} onPointerLeave={() => setHover(null)} />
        ))}
      </svg>
      {hover !== null && dates[hover] && (
        <Tooltip x={x(hover)} width={width} date={dates[hover]} locale={locale}
          rows={[{ key: series.key, label: series.label, slot: series.slot, text: series.display[hover] ?? '' }]} />
      )}
    </div>
  );
}

/** Horizontal ranking (top N) as plain HTML bars, value at the bar tip. */
export function RankBars({ label, items }: { label: string; items: Array<{ key: string; value: number; text: string }> }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <ol className="insights-viz space-y-2" aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className="grid grid-cols-[minmax(6rem,10rem)_1fr] items-center gap-3 text-sm">
          <span className="truncate text-muted-foreground" title={item.key}>{item.key}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="block rounded-r" style={{ height: 12, width: `${Math.max(2, (item.value / max) * 85)}%`, background: seriesColor(0) }} />
            <span className="shrink-0 tabular-nums text-foreground">{item.text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Table equivalent of a daily chart: one row per date, one column per series. */
export function SeriesTable({ caption, dates, series, locale, totals, labels }: {
  caption: string; dates: string[]; series: ChartSeries[]; locale: string; totals?: Array<string | null>; labels: { date: string; total: string };
}) {
  return (
    <div className="max-h-80 overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">{labels.date}</th>
            {series.map((entry) => <th key={entry.key} scope="col" className="px-3 py-2 text-right font-medium">{entry.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {dates.map((date, index) => (
            <tr key={date} className="border-t">
              <th scope="row" className="px-3 py-1.5 text-left font-normal text-muted-foreground">
                <time dateTime={date}>{formatDay(date, locale)}</time>
              </th>
              {series.map((entry) => <td key={entry.key} className="px-3 py-1.5 text-right tabular-nums">{entry.display[index]}</td>)}
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot className="border-t font-medium">
            <tr>
              <th scope="row" className="px-3 py-1.5 text-left">{labels.total}</th>
              {totals.map((total, index) => <td key={series[index]?.key ?? index} className="px-3 py-1.5 text-right tabular-nums">{total ?? '—'}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Chart or table of the same data; the toggle is a pressed-state button pair. */
export function ChartOrTable({ chart, table, labels }: { chart: ReactNode; table: ReactNode; labels: { chart: string; table: string } }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <div className="space-y-2">
      <div className="flex justify-end gap-1" role="group">
        {(['chart', 'table'] as const).map((value) => (
          <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground">
            {labels[value]}
          </button>
        ))}
      </div>
      {view === 'chart' ? chart : table}
    </div>
  );
}
