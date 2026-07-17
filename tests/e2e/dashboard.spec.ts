import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const loadBuiltApp = async (page: import("@playwright/test").Page, url = "https://focus-pet.local/") => {
  const dist = join(process.cwd(), "dist");
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const cssFile = html.match(/href="\.\/(assets\/[^"]+\.css)"/)?.[1];
  const jsFile = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1];
  if (!cssFile || !jsFile) throw new Error("Unable to locate built CSS/JS assets");
  const css = readFileSync(join(dist, cssFile), "utf8");
  const js = readFileSync(join(dist, jsFile), "utf8");
  await page.route("https://focus-pet.local/**", (route) => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/+/, "");
    const assetPath = pathname ? join(dist, pathname) : "";
    if (assetPath && existsSync(assetPath)) {
      const contentType = pathname.endsWith(".png")
        ? "image/png"
        : pathname.endsWith(".json")
          ? "application/json"
          : pathname.endsWith(".css")
            ? "text/css"
            : "application/javascript";
      return route.fulfill({ status: 200, contentType, body: readFileSync(assetPath) });
    }
    return route.fulfill({ status: 200, body: "<!doctype html><div id=\"root\"></div>" });
  });
  await page.goto(url);
  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>${css}</style>
      </head>
      <body>
        <div id="root"></div>
        <script>window.__vite_is_modern_browser = true;</script>
        <script type="module">${js}</script>
      </body>
    </html>
  `);
};

test("Swift-style shell and Today surface render", async ({ page }) => {
  await loadBuiltApp(page);
  const dashboardNav = page.getByRole("navigation", { name: "Dashboard" });
  await expect(dashboardNav.getByRole("button", { name: "今日" })).toBeVisible();
  await expect(page.getByLabel("桌宠停靠区")).toHaveCount(0);
  await expect(page.getByText("今日态势")).toBeVisible();
  await expect(page.getByText("电脑状态")).toBeVisible();
  await expect(page.getByText("专注占比")).toBeVisible();
  await expect(page.getByText("最长连贯")).toBeVisible();
  await expect(page.locator(".today-mini-pet img")).toBeAttached();
  await expect(page.locator(".today-top-app-stat .today-top-app-icon")).toBeVisible();
  await expect(page.getByText("已进入稳定工作")).toHaveCount(0);
  await expect(page.getByText(/App、输入和切换节奏/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "活动时间窗" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "6h" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "24h" })).toBeVisible();
  await expect(page.getByText("App", { exact: true })).toHaveCount(0);
  await expect(page.locator(".input-bars")).toBeVisible();
  await expect(page.locator(".input-stack").first()).toBeVisible();
  await expect(page.locator(".input-stack .pointer-segment").first()).toBeAttached();
  await expect(page.locator(".input-stack .keyboard-segment").first()).toBeAttached();
  if ((page.viewportSize()?.width ?? 0) >= 900) {
    const topCardHeights = await page.locator(".today-top-grid > section").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
    expect(Math.max(...topCardHeights) - Math.min(...topCardHeights)).toBeLessThanOrEqual(1);
    const focusColumns = await page.evaluate(() => {
      const duration = document.querySelector(".today-focus-hero")?.getBoundingClientRect();
      const stats = document.querySelector(".today-focus-stat-grid")?.getBoundingClientRect();
      return { durationRight: duration?.right ?? 0, statsLeft: stats?.left ?? 0 };
    });
    expect(focusColumns.durationRight).toBeLessThanOrEqual(focusColumns.statsLeft);
  }
  await expect(page.getByText("时间去哪了")).toBeVisible();
  const appListLayout = await page.locator(".today-app-usage-list").evaluate((list) => {
    const style = getComputedStyle(list);
    return { maxHeight: style.maxHeight, overflowY: style.overflowY, gridAutoRows: style.gridAutoRows };
  });
  expect(appListLayout).toMatchObject({ maxHeight: "264px", overflowY: "auto", gridAutoRows: "48px" });
  await expect(page.locator(".today-app-meter-fill").first()).toBeVisible();
  expect(await page.locator(".today-app-meter-fill > span[class^='state-']").count()).toBeGreaterThan(0);
  await expect(page.locator(".today-app-meter i")).toHaveCount(0);
  await expect(page.getByText("窗口节奏")).toBeVisible();
  await expect(page.getByLabel("窗口节奏填充饼图")).toBeVisible();
  await expect(page.locator(".rhythm-legend-list")).toHaveCount(0);
  await expect(page.locator(".fp-pie-depth")).toBeVisible();
  await expect(page.locator(".fp-pie-face")).toBeVisible();
  await expect(page.locator(".fp-pie-primary")).toBeVisible();
  await expect(page.locator(".rhythm-pie")).toHaveCount(0);
  await dashboardNav.getByRole("button", { name: /历史/ }).click();
  await expect(page.getByRole("heading", { name: "注意力热力图" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "周视图" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "月视图" })).toBeVisible();
  const heatmapLegend = page.locator('[aria-label="热力图图例"]');
  await expect(heatmapLegend).toBeVisible();
  await expect(heatmapLegend.getByText("时长")).toBeVisible();
  await expect(heatmapLegend.getByText("0-12h+")).toBeVisible();
  await expect(heatmapLegend.getByText("波动")).toBeVisible();
  await expect(heatmapLegend.getByText("偏离")).toBeVisible();
  await expect(page.getByRole("heading", { name: "历史洞察" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "3天" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "7天" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "15天" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "30天" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "60天" })).toBeVisible();
  await expect(page.getByRole("button", { name: "跳过周末" })).toBeVisible();
  await expect(page.getByText("日均应用活跃")).toBeVisible();
  await expect(page.locator(".activity-app-icon").first()).toBeVisible();
  await expect(page.getByText("日均活跃输入")).toBeVisible();
  await page.locator(".fp-week-heatmap .heatmap-cell").first().hover();
  await expect(page.locator(".heatmap-hover-card")).toBeVisible();
  await expect(page.locator(".heatmap-hover-card").getByText("专注占比")).toBeVisible();
  await page.getByRole("radio", { name: "月视图" }).click();
  await expect(page.locator(".swift-month-panel-header").first()).toBeVisible();
  await expect(page.locator(".swift-month-panel-header span").first()).toContainText(/秒|分|小时/);
  await page.locator(".activity-hour-slot").first().hover();
  await expect(page.locator(".hour-hover-card")).toBeVisible();
  await dashboardNav.getByRole("button", { name: "桌宠" }).click();
  await expect(page.locator(".workspace-header")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "显示行为" })).toBeVisible();
  await dashboardNav.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("navigation", { name: "设置模块" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "桌面状态卡" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "识别", exact: true })).toBeVisible();
});

test("development component gallery renders every primitive family", async ({ page }) => {
  await loadBuiltApp(page, "https://focus-pet.local/__gallery");
  await expect(page.getByRole("heading", { name: "Focus Pet 设计系统" })).toBeVisible();
  await expect(page.locator(".fp-semantic-card")).toHaveCount(9);
  await expect(page.locator(".fp-filled-pie")).toBeVisible();
  await expect(page.locator(".fp-hourly-bars")).toBeVisible();
  await expect(page.locator(".fp-heatmap")).toBeVisible();
});

test("computer monitor can be customized and keeps the Today cards aligned", async ({ page }) => {
  await loadBuiltApp(page);
  await page.getByRole("button", { name: "自定义电脑状态模块" }).click();
  await expect(page.getByLabel("电脑状态模块排版")).toBeVisible();
  await page.getByRole("button", { name: "分核 每个逻辑核心" }).click();
  await expect(page.getByText("CPU 分核")).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) >= 900) {
    const heights = await page.locator(".today-top-grid > section").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  }
  await expect(page.getByText(/休息/)).toHaveCount(0);
});

test("timeline density scales with its window and hover colors follow every theme", async ({ page }) => {
  await loadBuiltApp(page);
  const dashboardNav = page.getByRole("navigation", { name: "Dashboard" });
  const barDensity = async () => page.locator(".input-stack").first().evaluate((bar) =>
    Number.parseFloat(getComputedStyle(bar).getPropertyValue("--timeline-density")),
  );
  await page.getByRole("radio", { name: "2h", exact: true }).click();
  const twoHourDensity = await barDensity();
  await page.getByRole("radio", { name: "24h", exact: true }).click();
  const twentyFourHourDensity = await barDensity();
  expect(twentyFourHourDensity).toBeGreaterThan(twoHourDensity);

  await dashboardNav.getByRole("button", { name: "设置" }).click();
  const themeNames = [
    "新粗野主义 Neobrutalism 饱和色块、粗黑描边与硬偏移阴影",
    "中世纪现代 Mid-Century Modern 奶咖底色、胡桃木文字与温暖有机色彩",
    "构成主义 Constructivism 红黑块面、新闻纸底与前倾的海报构图",
  ];
  const colors: string[] = [];
  for (const name of themeNames) {
    await page.getByRole("radio", { name, exact: true }).click();
    colors.push(await page.locator("html").evaluate((root) => getComputedStyle(root).getPropertyValue("--chart-kbd").trim()));
  }
  expect(new Set(colors).size).toBe(3);
  await dashboardNav.getByRole("button", { name: "今日" }).click();
  await page.locator(".input-stack").last().hover();
  await expect(page.locator(".timeline-hover-bubble")).toBeVisible();
  const hoverColor = await page.locator(".timeline-hover-bubble").evaluate((bubble) => getComputedStyle(bubble).borderColor);
  expect(hoverColor).not.toBe("rgb(101, 230, 91)");
  expect(hoverColor).not.toBe("rgb(108, 69, 255)");
});

test("desktop widget views render without the main runtime shell", async ({ page }) => {
  await page.setViewportSize({ width: 190, height: 190 });
  await loadBuiltApp(page, "https://focus-pet.local/?widget=currentStatus");
  await expect(page.locator(".widget-status")).toBeVisible();
  await expect(page.getByText("当前状态")).toBeVisible();
  await expect(page.getByText(/已稳定/)).toBeVisible();
  await expect(page.getByText(/键/)).toBeVisible();
  const statusMetrics = await page.evaluate(() => {
    const card = document.querySelector(".widget-status") as HTMLElement | null;
    return {
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      cardWidth: card?.clientWidth ?? 0,
      cardScrollWidth: card?.scrollWidth ?? 0,
      cardHeight: card?.clientHeight ?? 0,
      cardScrollHeight: card?.scrollHeight ?? 0,
    };
  });
  expect(statusMetrics.pageWidth).toBeLessThanOrEqual(190);
  expect(statusMetrics.pageHeight).toBeLessThanOrEqual(190);
  expect(statusMetrics.cardScrollWidth).toBeLessThanOrEqual(statusMetrics.cardWidth);
  expect(statusMetrics.cardScrollHeight).toBeLessThanOrEqual(statusMetrics.cardHeight);

  await page.setViewportSize({ width: 380, height: 190 });
  await loadBuiltApp(page, "https://focus-pet.local/?widget=recentRhythm");
  await expect(page.locator(".widget-rhythm")).toBeVisible();
  await expect(page.getByText("最近节奏")).toBeVisible();
  await expect(page.getByRole("radio", { name: "4h" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "8h" })).toBeVisible();
  await expect(page.getByLabel("最近状态时间线")).toBeVisible();
  await page.getByRole("radio", { name: "8h" }).click();
  await expect(page.getByText("近 8 小时稳定")).toBeVisible();
  const rhythmMetrics = await page.evaluate(() => {
    const card = document.querySelector(".widget-rhythm") as HTMLElement | null;
    return {
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      cardWidth: card?.clientWidth ?? 0,
      cardScrollWidth: card?.scrollWidth ?? 0,
      cardHeight: card?.clientHeight ?? 0,
      cardScrollHeight: card?.scrollHeight ?? 0,
    };
  });
  expect(rhythmMetrics.pageWidth).toBeLessThanOrEqual(380);
  expect(rhythmMetrics.pageHeight).toBeLessThanOrEqual(190);
  expect(rhythmMetrics.cardScrollWidth).toBeLessThanOrEqual(rhythmMetrics.cardWidth);
  expect(rhythmMetrics.cardScrollHeight).toBeLessThanOrEqual(rhythmMetrics.cardHeight);

  await page.setViewportSize({ width: 330, height: 430 });
  await loadBuiltApp(page, "https://focus-pet.local/?widget=petCompanion");
  await expect(page.locator(".window-pet")).toBeVisible();
  await expect(page.locator(".window-pet img")).toBeVisible();
  await page.locator(".window-pet").dispatchEvent("pointerover");
  await expect(page.getByRole("button", { name: "桌宠切换动作" })).toBeVisible();
  await expect(page.getByText("当前状态")).toBeVisible();
  await expect(page.getByText("专注", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开桌宠面板" })).toContainText("面板");
  await expect(page.getByRole("button", { name: "桌宠切换动作" })).toContainText("动作");
  await expect(page.getByRole("button", { name: "打开桌宠设置" })).toContainText("设置");
  const hoverPanelStyle = await page.locator(".pet-hover-panel").evaluate((panel) => {
    const style = getComputedStyle(panel);
    return { width: panel.getBoundingClientRect().width, background: style.backgroundColor };
  });
  expect(hoverPanelStyle.width).toBeGreaterThanOrEqual(268);
  expect(hoverPanelStyle.background).not.toMatch(/\/ 0\.|rgba\([^)]*,\s*0\./);

  await page.setViewportSize({ width: 360, height: 374 });
  await loadBuiltApp(page, "https://focus-pet.local/?widget=menuBar");
  await expect(page.locator(".menu-bar-card")).toBeVisible();
  await expect(page.getByLabel("状态摘要")).toBeVisible();
  await expect(page.getByRole("button", { name: "打开面板" })).toBeVisible();
  await expect(page.getByRole("button", { name: "桌面状态卡" })).toBeVisible();
  await expect(page.getByRole("button", { name: /显示桌宠|隐藏桌宠/ })).toBeVisible();
  await expect(page.getByText("提醒开启")).toBeVisible();
  await expect(page.getByRole("button", { name: "退出" })).toBeVisible();
  await expect(page.getByText("等待主窗口同步")).toBeHidden();
  const menuMetrics = await page.evaluate(() => {
    const card = document.querySelector(".menu-bar-card") as HTMLElement | null;
    return {
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      cardWidth: card?.clientWidth ?? 0,
      cardScrollWidth: card?.scrollWidth ?? 0,
      cardHeight: card?.clientHeight ?? 0,
      cardScrollHeight: card?.scrollHeight ?? 0,
    };
  });
  expect(menuMetrics.pageWidth).toBeLessThanOrEqual(360);
  expect(menuMetrics.pageHeight).toBeLessThanOrEqual(374);
  expect(menuMetrics.cardScrollWidth).toBeLessThanOrEqual(menuMetrics.cardWidth);
  expect(menuMetrics.cardScrollHeight).toBeLessThanOrEqual(menuMetrics.cardHeight);
});

test("settings expose all modules without a secondary navigation rail", async ({ page }) => {
  await loadBuiltApp(page);
  await page.getByRole("navigation", { name: "Dashboard" }).getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("navigation", { name: "设置模块" })).toHaveCount(0);
  for (const title of ["外观主题", "桌面状态卡", "提醒", "识别", "权限", "数据", "关于"]) {
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  const settingsWidths = await page.locator(".settings-content-panel").evaluateAll((panels) => panels.map((panel) => panel.getBoundingClientRect().width));
  expect(Math.max(...settingsWidths) - Math.min(...settingsWidths)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "当前状态卡" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "固定位置" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "自由拖动" })).toBeVisible();

  await expect(page.getByText("回归提醒")).toBeVisible();
  await expect(page.getByRole("heading", { name: "智能体任务" })).toBeVisible();
  await expect(page.getByText("Codex / Claude Code 完成通知")).toBeVisible();
  await expect(page.getByRole("button", { name: "测试桌宠通知" })).toBeVisible();
  await expect(page.getByText("温和走神阈值")).toBeVisible();
  await expect(page.locator(".settings-module-reminders .settings-number-stepper")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "温和走神阈值 增加" })).toBeVisible();
  await page.getByRole("button", { name: "温和走神阈值 增加" }).click();
  await expect(page.getByRole("group", { name: "温和走神阈值 6分钟" })).toBeVisible();

  await expect(page.getByRole("radio", { name: "宽松" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "平衡" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "严格" })).toBeVisible();
  await expect(page.locator(".settings-module-recognition .settings-number-stepper")).toHaveCount(4);
  await expect(page.locator(".settings-number-control")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /刷新诊断/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /清空例外/ })).toBeVisible();

  await expect(page.getByText("刷新于")).toBeVisible();
  await expect(page.getByRole("button", { name: "请求" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "测试", exact: true })).toBeVisible();
  await expect(page.getByText("隐私与安全")).toBeVisible();

  await expect(page.getByText("本机数据")).toBeVisible();
  await expect(page.getByText("启用日志")).toBeVisible();
  await expect(page.getByRole("button", { name: /打开日志/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /复制路径/ })).toBeVisible();
});

test("appearance themes switch globally and persist their selection", async ({ page }) => {
  await loadBuiltApp(page);
  await page.getByRole("navigation", { name: "Dashboard" }).getByRole("button", { name: "设置" }).click();
  const midCentury = page.getByRole("radio", {
    name: "中世纪现代 Mid-Century Modern 奶咖底色、胡桃木文字与温暖有机色彩",
    exact: true,
  });
  const constructivism = page.getByRole("radio", {
    name: "构成主义 Constructivism 红黑块面、新闻纸底与前倾的海报构图",
    exact: true,
  });

  await midCentury.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "mid-century-modern");
  await expect(midCentury).toHaveAttribute("aria-checked", "true");

  await constructivism.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "constructivism");
  await expect(constructivism).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("focus-pet-appearance-theme"))).toBe("constructivism");
});

test("pet settings expose hover and random action controls", async ({ page }) => {
  await loadBuiltApp(page);
  await page.getByRole("navigation", { name: "Dashboard" }).getByRole("button", { name: "桌宠" }).click();
  await expect(page.locator(".workspace-header")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "显示行为" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "位置外观" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "资源包", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /暂无桌宠资源包/ })).toBeVisible();
  await expect(page.locator(".pet-pack-grid")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "动作映射" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /悬浮状态弹窗/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /随机换动作/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: "90 秒" })).toBeVisible();
  const petSectionWidths = await page.locator(".pet-settings-section").evaluateAll((sections) => sections.map((section) => section.getBoundingClientRect().width));
  expect(Math.max(...petSectionWidths) - Math.min(...petSectionWidths)).toBeLessThanOrEqual(2);
});
