// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl, Stepper, TogglePill } from "../components/ui";
import { durationColorStep, timeToProgress } from "../components/charts/scale";
import { CodexSessionPanel } from "../components/CodexSessionPanel";
import type { CodexSessionSnapshot } from "../core/codexSessions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const render = (node: React.ReactNode) => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
};

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("frontend design-system primitives", () => {
  it("maps timestamps and heatmap durations onto stable chart scales", () => {
    expect(timeToProgress(150, { start: 100, end: 200 })).toBe(0.5);
    expect(timeToProgress(240, { start: 100, end: 200 })).toBe(1);
    expect(durationColorStep(50, 100, 9)).toBe(5);
    expect(durationColorStep(0, 100, 9)).toBe(0);
  });

  it("moves segmented selection with arrow keys and skips disabled options", () => {
    const onChange = vi.fn();
    const container = render(
      <SegmentedControl
        label="时间范围"
        value={2}
        options={[
          { value: 2, label: "2h" },
          { value: 4, label: "4h", disabled: true },
          { value: 8, label: "8h" },
        ]}
        onChange={onChange}
      />,
    );
    const selected = container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]');
    act(() => selected?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onChange).toHaveBeenCalledWith(8);
  });

  it("exposes an unambiguous pressed state on toggle pills", () => {
    const onCheckedChange = vi.fn();
    const container = render(<TogglePill checked status="pet" onCheckedChange={onCheckedChange}>动画</TogglePill>);
    const toggle = container.querySelector<HTMLButtonElement>("button");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.querySelector("svg")).not.toBeNull();
    act(() => toggle?.click());
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("disables steppers at numeric bounds", () => {
    const container = render(<Stepper label="阈值" value={1} min={1} max={3} onChange={() => undefined} />);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="阈值 减少"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="阈值 增加"]')?.disabled).toBe(false);
  });

  it("renders only active Codex sessions, Markdown, and a working collapse control", () => {
    const session = (
      sessionId: string,
      hostId: string,
      runtime: string,
      text: string,
    ): CodexSessionSnapshot => ({
      hostId,
      hostKind: hostId === "local" ? "local" : "ssh",
      sessionId,
      title: sessionId,
      lifecycle: "open",
      runtime,
      activeFlags: [],
      currentTurn: { turnId: `${sessionId}-turn`, status: runtime === "active" ? "inProgress" : "completed" },
      latestVisibleMessage: {
        role: "assistant",
        text,
        isFinal: runtime !== "active",
        updatedAt: "2026-07-30T12:00:00.000Z",
      },
      capabilityMode: "managed",
      updatedAt: "2026-07-30T12:00:00.000Z",
    });
    const container = render(
      <CodexSessionPanel sessions={[
        session("local-task", "local", "active", "**实时更新**\n\n- 第一项\n- 第二项"),
        session("remote-task", "build-server", "idle", "远程任务完成"),
      ]} />,
    );

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(container.textContent).toContain("1 个任务运行中");
    expect(container.textContent).not.toContain("远程任务完成");
    expect(container.querySelector(".codex-markdown strong")?.textContent).toBe("实时更新");
    expect(container.querySelectorAll(".codex-markdown li")).toHaveLength(2);

    const collapse = container.querySelector<HTMLButtonElement>('[aria-label="收起 Codex 会话"]');
    act(() => collapse?.click());
    expect(container.textContent).toContain("1 个任务运行中");
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });
});
