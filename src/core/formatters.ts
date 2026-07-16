export const formatDuration = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${secs > 0 && minutes < 5 ? `${secs} 秒` : ""}`.trim();
  return `${secs} 秒`;
};

export const formatCompactDuration = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${safe}s`;
};

export const formatPercentage = (ratio: number): string => `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;

export const formatCount = (count: number): string => {
  const safe = Math.max(0, Math.round(count));
  if (safe >= 10_000) return `${(safe / 10_000).toFixed(1)} 万`;
  if (safe >= 1000) return `${(safe / 1000).toFixed(1)}k`;
  return `${safe}`;
};

export const formatClock = (date: string | Date): string => {
  const value = typeof date === "string" ? new Date(date) : date;
  return value.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
};

export const formatDate = (date: string | Date): string => {
  const value = typeof date === "string" ? new Date(date) : date;
  return value.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
};
