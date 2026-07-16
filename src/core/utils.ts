export const secondsBetween = (start: string | Date, end: string | Date): number => {
  const s = typeof start === "string" ? new Date(start).getTime() : start.getTime();
  const e = typeof end === "string" ? new Date(end).getTime() : end.getTime();
  return Math.max(0, Math.round((e - s) / 1000));
};

export const addSeconds = (date: string | Date, seconds: number): string => {
  const base = typeof date === "string" ? new Date(date) : date;
  return new Date(base.getTime() + seconds * 1000).toISOString();
};

export const clamp = (value: number, lower: number, upper: number): number =>
  Math.min(upper, Math.max(lower, value));

export const safeTrim = (value: string | undefined | null): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
};

export const makeID = (prefix = "fp"): string => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const dayBounds = (date: Date): { start: Date; end: Date } => {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
};

export const dateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const overlapSeconds = (
  start: string | Date,
  end: string | Date,
  bounds: { start: Date; end: Date },
): number => {
  const s = typeof start === "string" ? new Date(start) : start;
  const e = typeof end === "string" ? new Date(end) : end;
  const clippedStart = new Date(Math.max(s.getTime(), bounds.start.getTime()));
  const clippedEnd = new Date(Math.min(e.getTime(), bounds.end.getTime()));
  return secondsBetween(clippedStart, clippedEnd);
};

export const overlaps = (
  start: string | Date,
  end: string | Date,
  bounds: { start: Date; end: Date },
): boolean => {
  const s = typeof start === "string" ? new Date(start) : start;
  const e = typeof end === "string" ? new Date(end) : end;
  return e > bounds.start && s < bounds.end;
};

export const hashText = (text: string): string => {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
};

export const redactWindowTitle = (title: string): string => {
  const capped = title.trim().slice(0, 28);
  return capped.replace(/[A-Za-z0-9._%+-]{2,}/g, "•");
};

export const byStart = <T extends { start: string }>(items: T[]): T[] =>
  [...items].sort((lhs, rhs) => new Date(lhs.start).getTime() - new Date(rhs.start).getTime());

export const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
