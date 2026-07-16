import { FocusPetAppContext } from "./app/AppContext";
import { useFocusPetApp } from "./app/useFocusPetApp";
import { AppShell } from "./components/AppShell";
import { MenuBarView } from "./components/MenuBarView";
import { PetCompanionWindow } from "./components/PetCompanion";
import { PrimitiveGallery } from "./components/PrimitiveGallery";
import { PetTab } from "./components/PetTab";
import { SessionsTab } from "./components/SessionsTab";
import { SettingsTab } from "./components/SettingsTab";
import { TodayTab } from "./components/TodayTab";
import { WidgetView } from "./components/WidgetView";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/primitives.css";
import "./styles/charts.css";
import "./styles/shell.css";
import "./styles/today.css";
import "./styles/history.css";
import "./styles/pet.css";
import "./styles/settings.css";
import "./styles/widgets.css";

const MainApp = () => {
  const app = useFocusPetApp();
  const page = {
    today: <TodayTab />,
    sessions: <SessionsTab />,
    pet: <PetTab />,
    settings: <SettingsTab />,
  }[app.selectedTab];

  return (
    <FocusPetAppContext.Provider value={app}>
      <AppShell app={app}>
        {app.ready ? page : <div className="boot-panel">Focus Pet 正在载入本地状态</div>}
      </AppShell>
    </FocusPetAppContext.Provider>
  );
};

function App() {
  if ((import.meta.env.DEV || navigator.webdriver) && window.location.pathname === "/__gallery") {
    return <PrimitiveGallery />;
  }
  const widgetMode = new URLSearchParams(window.location.search).get("widget");
  if (widgetMode === "currentStatus" || widgetMode === "recentRhythm") {
    return <WidgetView mode={widgetMode} />;
  }
  if (widgetMode === "petCompanion") {
    return <PetCompanionWindow />;
  }
  if (widgetMode === "menuBar") {
    return <MenuBarView />;
  }

  return <MainApp />;
}

export default App;
