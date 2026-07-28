import type { NativeActivitySample } from "../core/types";
import { makeMockActivitySample } from "./mockNative";

export const activitySampleForRuntime = (
  nativeSample: NativeActivitySample | undefined,
  nativeRuntime: boolean,
  now = new Date(),
): NativeActivitySample | undefined => {
  if (nativeSample) return nativeSample;
  return nativeRuntime ? undefined : makeMockActivitySample(now);
};
