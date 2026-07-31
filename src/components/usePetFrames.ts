import { useEffect, useMemo, useState } from "react";

/**
 * Preloads the current action before advancing its animation. WebView2 can
 * otherwise cancel a local asset request when `src` changes again before the
 * previous frame has decoded, leaving a transparent companion indefinitely.
 */
export const usePetFrames = (frameURLs: string[], fallbackURL?: string): string[] => {
  const signature = frameURLs.join("\n");
  const candidates = useMemo(() => (signature ? signature.split("\n") : []), [signature]);
  const [loadedFrames, setLoadedFrames] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (candidates.length === 0) {
      setLoadedFrames([]);
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(candidates.map((url) => new Promise<string | undefined>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(url);
      image.onerror = () => resolve(undefined);
      image.src = url;
    }))).then((results) => {
      if (!cancelled) {
        const nextFrames = results.filter((url): url is string => Boolean(url));
        setLoadedFrames(nextFrames);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [candidates]);

  return loadedFrames.length > 0 ? loadedFrames : fallbackURL ? [fallbackURL] : [];
};
