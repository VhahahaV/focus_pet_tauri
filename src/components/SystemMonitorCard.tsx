import {
  ChevronDown,
  ChevronUp,
  Cpu,
  Fan,
  Gauge,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Settings2,
  Thermometer,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useFocusPet } from "../app/AppContext";
import { makeMockSystemMetrics } from "../app/mockNative";
import type { SystemMetricsSample, SystemMonitorModule } from "../core/types";
import { isTauriRuntime, nativeSystemMetrics } from "../store/native";
import { SemanticCard } from "./ui";

const availableModules: Array<{
  id: SystemMonitorModule;
  title: string;
  description: string;
  Icon: typeof Cpu;
}> = [
  { id: "cpu", title: "CPU", description: "总体负载", Icon: Cpu },
  { id: "cores", title: "分核", description: "每个逻辑核心", Icon: Gauge },
  { id: "memory", title: "内存", description: "统一内存占用", Icon: MemoryStick },
  { id: "disk", title: "磁盘", description: "系统盘空间", Icon: HardDrive },
  { id: "gpu", title: "GPU", description: "设备利用率", Icon: Gauge },
  { id: "thermal", title: "温度与风扇", description: "设备支持时显示", Icon: Thermometer },
];

const clampPercent = (value: number | undefined): number => Math.max(0, Math.min(100, value ?? 0));

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

const UsageMeter = ({ value, label }: { value: number; label: string }) => (
  <div className="system-usage-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
    <span style={{ "--system-usage": `${clampPercent(value)}%` } as CSSProperties} />
  </div>
);

const MetricModule = ({ module, sample }: { module: SystemMonitorModule; sample: SystemMetricsSample }) => {
  const disk = sample.disks.find((item) => item.mountPoint === "/") ?? sample.disks[0];
  switch (module) {
    case "cpu":
      return (
        <article className="system-monitor-module module-cpu">
          <header><Cpu size={15} /><span>CPU</span><strong>{Math.round(sample.cpuUsage)}%</strong></header>
          <UsageMeter value={sample.cpuUsage} label={`CPU 使用率 ${Math.round(sample.cpuUsage)}%`} />
          <small>{sample.cpuName} · {sample.cores.length} 核</small>
        </article>
      );
    case "cores":
      return (
        <article className="system-monitor-module module-cores">
          <header><Gauge size={15} /><span>CPU 分核</span><strong>{sample.cores.length}</strong></header>
          <div className="system-core-grid">
            {sample.cores.map((core, index) => (
              <span key={`${core.name}-${index}`} title={`${core.name} ${Math.round(core.usage)}%`}>
                <i style={{ "--core-usage": `${clampPercent(core.usage)}%` } as CSSProperties} />
                <em>{index + 1}</em>
                <strong>{Math.round(core.usage)}</strong>
              </span>
            ))}
          </div>
        </article>
      );
    case "memory":
      return (
        <article className="system-monitor-module module-memory">
          <header><MemoryStick size={15} /><span>内存</span><strong>{Math.round(sample.memoryUsage)}%</strong></header>
          <UsageMeter value={sample.memoryUsage} label={`内存使用率 ${Math.round(sample.memoryUsage)}%`} />
          <small>{formatBytes(sample.memoryUsedBytes)} / {formatBytes(sample.memoryTotalBytes)}</small>
        </article>
      );
    case "disk":
      return (
        <article className="system-monitor-module module-disk">
          <header><HardDrive size={15} /><span>磁盘</span><strong>{disk ? `${Math.round(disk.usage)}%` : "—"}</strong></header>
          {disk ? <UsageMeter value={disk.usage} label={`磁盘使用率 ${Math.round(disk.usage)}%`} /> : null}
          <small>{disk ? `${formatBytes(disk.totalBytes - disk.availableBytes)} / ${formatBytes(disk.totalBytes)}` : "未读取到磁盘信息"}</small>
        </article>
      );
    case "gpu":
      return (
        <article className="system-monitor-module module-gpu">
          <header><Gauge size={15} /><span>GPU</span><strong>{sample.gpuUsage == null ? "—" : `${Math.round(sample.gpuUsage)}%`}</strong></header>
          {sample.gpuUsage == null ? null : <UsageMeter value={sample.gpuUsage} label={`GPU 使用率 ${Math.round(sample.gpuUsage)}%`} />}
          <small>{sample.gpuName ?? "当前设备未提供 GPU 利用率"}</small>
        </article>
      );
    case "thermal": {
      const hottest = [...sample.temperatures].sort((lhs, rhs) => rhs.celsius - lhs.celsius)[0];
      const fastest = [...sample.fans].sort((lhs, rhs) => rhs.rpm - lhs.rpm)[0];
      return (
        <article className="system-monitor-module module-thermal">
          <header>{fastest ? <Fan size={15} /> : <Thermometer size={15} />}<span>温度与风扇</span><strong>{hottest ? `${Math.round(hottest.celsius)}°` : fastest ? `${fastest.rpm} RPM` : "—"}</strong></header>
          <small>{hottest ? hottest.label : fastest ? fastest.label : "系统未公开可用传感器"}</small>
        </article>
      );
    }
  }
};

export const SystemMonitorCard = () => {
  const { bundle, actions } = useFocusPet();
  const settings = bundle.state.settings.systemMonitor;
  const [sample, setSample] = useState<SystemMetricsSample>();
  const [error, setError] = useState<string>();
  const [isCustomizing, setIsCustomizing] = useState(false);
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const next = await nativeSystemMetrics();
      setSample(next ?? makeMockSystemMetrics());
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), settings.refreshSeconds * 1000);
    return () => window.clearInterval(interval);
  }, [refresh, settings.refreshSeconds]);

  const orderedModules = useMemo(() => settings.modules.filter((module) =>
    availableModules.some((item) => item.id === module),
  ), [settings.modules]);

  const updateModules = (modules: SystemMonitorModule[]) => actions.updateSettings((current) => ({
    ...current,
    systemMonitor: { ...current.systemMonitor, modules },
  }));
  const toggleModule = (module: SystemMonitorModule) => {
    if (orderedModules.includes(module)) {
      if (orderedModules.length > 1) updateModules(orderedModules.filter((item) => item !== module));
    } else {
      updateModules([...orderedModules, module]);
    }
  };
  const moveModule = (module: SystemMonitorModule, direction: -1 | 1) => {
    const index = orderedModules.indexOf(module);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= orderedModules.length) return;
    const next = [...orderedModules];
    [next[index], next[target]] = [next[target], next[index]];
    updateModules(next);
  };

  return (
    <SemanticCard status="info" className="system-monitor-card">
      <div className="system-monitor-header">
        <div>
          <span><Gauge size={16} /></span>
          <div><strong>电脑状态</strong><small>{isTauriRuntime() ? "实时本机数据" : "浏览器预览数据"}</small></div>
        </div>
        <div>
          <button type="button" className="system-monitor-icon-button" aria-label="立即刷新电脑状态" onClick={() => void refresh()}><RefreshCw size={14} /></button>
          <button type="button" className="system-monitor-icon-button" aria-label="自定义电脑状态模块" aria-pressed={isCustomizing} onClick={() => setIsCustomizing((value) => !value)}><Settings2 size={14} /></button>
        </div>
      </div>
      {error ? <p className="system-monitor-error">读取失败：{error}</p> : null}
      {sample ? (
        <div className="system-monitor-module-grid">
          {orderedModules.map((module) => <MetricModule key={module} module={module} sample={sample} />)}
        </div>
      ) : <div className="system-monitor-loading">正在读取硬件状态…</div>}
      {isCustomizing ? (
        <div className="system-monitor-customizer" aria-label="电脑状态模块排版">
          <div className="system-monitor-refresh-rate">
            <span>刷新</span>
            {[1, 2, 5, 10].map((seconds) => (
              <button
                key={seconds}
                type="button"
                aria-pressed={settings.refreshSeconds === seconds}
                onClick={() => actions.updateSettings((current) => ({ ...current, systemMonitor: { ...current.systemMonitor, refreshSeconds: seconds } }))}
              >{seconds}s</button>
            ))}
          </div>
          {availableModules.map(({ id, title, description, Icon }) => {
            const index = orderedModules.indexOf(id);
            const selected = index >= 0;
            return (
              <div className="system-monitor-custom-row" key={id}>
                <button type="button" className="system-monitor-module-toggle" aria-pressed={selected} onClick={() => toggleModule(id)}>
                  <Icon size={14} /><span><strong>{title}</strong><small>{description}</small></span>
                </button>
                <button type="button" aria-label={`${title}上移`} disabled={!selected || index === 0} onClick={() => moveModule(id, -1)}><ChevronUp size={13} /></button>
                <button type="button" aria-label={`${title}下移`} disabled={!selected || index === orderedModules.length - 1} onClick={() => moveModule(id, 1)}><ChevronDown size={13} /></button>
              </div>
            );
          })}
        </div>
      ) : null}
    </SemanticCard>
  );
};
