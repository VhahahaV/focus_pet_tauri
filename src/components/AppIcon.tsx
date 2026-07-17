import { useEffect, useState } from "react";
import type { ActivityCategory } from "../core/types";
import { nativeAppIcon } from "../store/native";

const appIconCache = new Map<string, string | null>();

interface AppIconProps {
  appName: string;
  bundleID?: string;
  category: ActivityCategory;
  className: string;
}

export const AppIcon = ({ appName, bundleID, category, className }: AppIconProps) => {
  const key = (bundleID?.trim() || appName.trim()).toLowerCase();
  const [iconURL, setIconURL] = useState<string | null | undefined>(() => appIconCache.get(key));

  useEffect(() => {
    let active = true;
    if (appIconCache.has(key)) {
      setIconURL(appIconCache.get(key));
      return () => { active = false; };
    }
    const loadIcon = async () => {
      try {
        const primaryURL = await nativeAppIcon(bundleID, appName);
        const url = primaryURL ?? (bundleID ? await nativeAppIcon(undefined, appName) : undefined);
        appIconCache.set(key, url ?? null);
        if (active) setIconURL(url ?? null);
      } catch {
        appIconCache.set(key, null);
        if (active) setIconURL(null);
      }
    };
    void loadIcon();
    return () => { active = false; };
  }, [appName, bundleID, key]);

  if (!iconURL) {
    return <span className={`${className} fallback category-${category}`}>{appName.trim().slice(0, 1).toUpperCase()}</span>;
  }

  return (
    <span className={className}>
      <img
        src={iconURL}
        alt=""
        onError={() => {
          appIconCache.set(key, null);
          setIconURL(null);
        }}
      />
    </span>
  );
};
