export interface TimeDomain {
  start: number;
  end: number;
}

export const timeToProgress = (timestamp: number, domain: TimeDomain) => {
  if (domain.end <= domain.start) return 0;
  return Math.max(0, Math.min(1, (timestamp - domain.start) / (domain.end - domain.start)));
};

export const durationColorStep = (value: number, max: number, steps = 9) => {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(steps, Math.ceil((value / max) * steps)));
};
