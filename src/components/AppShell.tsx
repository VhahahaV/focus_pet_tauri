import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Home,
  PawPrint,
  Settings,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { FocusPetAppController } from "../app/useFocusPetApp";
import type { DashboardTab } from "../app/types";
import { GlassSurface } from "./ui";

const tabs: Array<{ id: DashboardTab; title: string; icon: typeof Home }> = [
  { id: "today", title: "今日", icon: Home },
  { id: "sessions", title: "历史", icon: Clock3 },
  { id: "pet", title: "桌宠", icon: PawPrint },
  { id: "settings", title: "设置", icon: Settings },
];

const tabDescriptions: Record<DashboardTab, string> = {
  today: "当下节奏",
  sessions: "专注趋势",
  pet: "陪伴与行为",
  settings: "偏好与权限",
};

export const AppShell = ({
  app,
  children,
}: {
  app: FocusPetAppController;
  children: React.ReactNode;
}) => {
  const [announcement, setAnnouncement] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!app.ready || !app.bundle.state.statusMessage) return undefined;
    setAnnouncement(app.bundle.state.statusMessage);
    const timer = window.setTimeout(() => setAnnouncement(undefined), 3600);
    return () => window.clearTimeout(timer);
  }, [app.bundle.state.statusMessage, app.ready]);

  const announcementIsError = Boolean(announcement && /失败|无法|异常|错误/.test(announcement));
  const announcementIsWarning = Boolean(
    announcement && !announcementIsError && /暂无|需要|未开启|未授予/.test(announcement),
  );

  return (
    <div className="app-stage">
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand-mark">
            <img src={`${import.meta.env.BASE_URL}assets/AppIcon.png`} alt="" />
            <div>
              <strong>Focus Pet</strong>
              <span>陪你稳住专注</span>
            </div>
          </div>

          <nav className="sidebar-nav" aria-label="Dashboard">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const selected = app.selectedTab === tab.id;
              return (
                <button
                  className={`sidebar-tab ${selected ? "active" : ""}`}
                  key={tab.id}
                  type="button"
                  aria-label={tab.title}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => app.setSelectedTab(tab.id)}
                >
                  <span className="sidebar-icon">
                    <Icon size={23} strokeWidth={selected ? 2.7 : 2.2} />
                  </span>
                  <span>
                    <strong>{tab.title}</strong>
                    <small>{tabDescriptions[tab.id]}</small>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="dashboard-main">
          {app.installationNotice ? (
            <GlassSurface roleType="menu" status="warning" className="install-notice" role="status">
              <div>
                <strong>
                  {app.installationNotice.isRunningFromMountedVolume
                    ? "请先完成安装"
                    : `Focus Pet ${app.installationNotice.versionDisplay} 已就绪`}
                </strong>
                <span>
                  {app.installationNotice.isRunningFromMountedVolume
                    ? "请将 Focus Pet 拖到 Applications 或系统应用文件夹后再打开，避免权限与本地数据保存不稳定。"
                    : "你的本地数据会继续保存在用户应用支持目录中。"}
                </span>
              </div>
              <button type="button" onClick={app.actions.dismissInstallationNotice} aria-label="关闭安装提示">
                <X size={16} />
              </button>
            </GlassSurface>
          ) : null}
          {children}
          {announcement ? (
            <GlassSurface
              roleType="menu"
              status={announcementIsError ? "error" : announcementIsWarning ? "warning" : "rest"}
              className={`workspace-toast ${announcementIsError ? "is-error" : announcementIsWarning ? "is-warning" : "is-success"}`}
              role="status"
              aria-live="polite"
            >
              {announcementIsError ? (
                <AlertCircle size={16} />
              ) : announcementIsWarning ? (
                <AlertTriangle size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
              <span>{announcement}</span>
            </GlassSurface>
          ) : null}
        </main>
      </div>
    </div>
  );
};
