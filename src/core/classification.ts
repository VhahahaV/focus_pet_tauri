import type {
  ActivityCategory,
  ActivityClassificationSource,
  ClassificationCatalogEntry,
  ClassificationRule,
} from "./types";
import { makeID } from "./utils";

const fallbackRules: ClassificationRule[] = [
  { id: "fallback-cursor", matchKind: "appName", pattern: "Cursor", category: "work", priority: 500 },
  { id: "fallback-vscode", matchKind: "appName", pattern: "Visual Studio Code", category: "work", priority: 500 },
  { id: "fallback-xcode", matchKind: "appName", pattern: "Xcode", category: "work", priority: 500 },
  { id: "fallback-terminal", matchKind: "appName", pattern: "Terminal", category: "work", priority: 500 },
  { id: "fallback-figma", matchKind: "appName", pattern: "Figma", category: "work", priority: 500 },
  { id: "fallback-codex", matchKind: "appName", pattern: "Codex", category: "work", priority: 500 },
  { id: "fallback-openai-codex", matchKind: "bundleID", pattern: "com.openai.codex", category: "work", priority: 500 },
  { id: "fallback-chatgpt", matchKind: "appName", pattern: "ChatGPT", category: "work", priority: 500 },
  { id: "fallback-atlas", matchKind: "appName", pattern: "ChatGPT Atlas", category: "work", priority: 500 },
  { id: "fallback-cortex", matchKind: "appName", pattern: "Cortex", category: "work", priority: 500 },
  { id: "fallback-title-chatgpt", matchKind: "windowTitle", pattern: "ChatGPT", category: "work", priority: 700 },
  { id: "fallback-title-openai", matchKind: "windowTitle", pattern: "OpenAI", category: "work", priority: 700 },
  { id: "fallback-title-codex", matchKind: "windowTitle", pattern: "Codex", category: "work", priority: 700 },
  { id: "fallback-title-gpt", matchKind: "windowTitle", pattern: "GPT", category: "work", priority: 700 },
  { id: "fallback-steam", matchKind: "appName", pattern: "Steam", category: "entertainment", priority: 500 },
  { id: "fallback-youtube", matchKind: "windowTitle", pattern: "YouTube", category: "entertainment", priority: 700 },
  { id: "fallback-bilibili", matchKind: "windowTitle", pattern: "Bilibili", category: "entertainment", priority: 700 },
  { id: "fallback-douyin", matchKind: "windowTitle", pattern: "抖音", category: "entertainment", priority: 700 },
  { id: "fallback-1password", matchKind: "appName", pattern: "1Password", category: "ignore", priority: 500 },
  { id: "fallback-settings", matchKind: "appName", pattern: "System Settings", category: "ignore", priority: 500 },
  { id: "fallback-activity-monitor", matchKind: "appName", pattern: "Activity Monitor", category: "ignore", priority: 500 },
];

const ruleKey = (rule: ClassificationRule): string =>
  `${rule.matchKind}|${rule.pattern.trim().toLowerCase()}|${rule.category}`;

export const rulesFromCatalog = (entries: ClassificationCatalogEntry[]): ClassificationRule[] =>
  entries.flatMap((entry) =>
    entry.patterns.map((pattern, index) => ({
      id: `${entry.id}-${index}`,
      matchKind: entry.matchKind,
      pattern,
      category: entry.category,
      priority: entry.priority,
    })),
  );

export const userRulesFromStored = (
  storedRules: ClassificationRule[],
  defaultRules = fallbackRules,
): ClassificationRule[] => {
  const builtInKeys = new Set(defaultRules.map(ruleKey));
  return storedRules.filter((rule) => !builtInKeys.has(ruleKey(rule)) && rule.category !== "neutral");
};

export interface ActivityClassification {
  category: ActivityCategory;
  source: ActivityClassificationSource;
  ruleID?: string;
}

export class ActivityClassifier {
  readonly catalogEntries: ClassificationCatalogEntry[];
  readonly defaultRules: ClassificationRule[];
  readonly rules: ClassificationRule[];
  private readonly userRuleIDs: Set<string>;
  private readonly catalogBacked: boolean;

  constructor(userRules: ClassificationRule[] = [], catalogEntries: ClassificationCatalogEntry[] = []) {
    this.userRuleIDs = new Set(userRules.map((rule) => rule.id));
    this.catalogBacked = catalogEntries.length > 0;
    this.catalogEntries = catalogEntries;
    this.defaultRules = catalogEntries.length > 0 ? rulesFromCatalog(catalogEntries) : fallbackRules;
    const elevatedUserRules = userRules.map((rule, offset) => ({
      ...rule,
      priority: Math.max(rule.priority, 10_000 - offset),
    }));
    this.rules = [...elevatedUserRules, ...this.defaultRules]
      .filter((rule) => rule.pattern.trim().length > 0)
      .sort((lhs, rhs) => {
        if (lhs.priority === rhs.priority) return lhs.pattern.localeCompare(rhs.pattern, "zh-CN");
        return rhs.priority - lhs.priority;
      });
  }

  classify(appName: string, bundleID?: string, windowTitle?: string): ActivityCategory {
    return this.classifyDetailed(appName, bundleID, windowTitle).category;
  }

  classifyDetailed(appName: string, bundleID?: string, windowTitle?: string): ActivityClassification {
    const name = appName.toLowerCase();
    const bundle = bundleID?.toLowerCase() ?? "";
    const title = windowTitle?.toLowerCase() ?? "";
    for (const rule of this.rules) {
      const pattern = rule.pattern.trim().toLowerCase();
      const matches =
        rule.matchKind === "appName"
          ? name.includes(pattern)
          : rule.matchKind === "bundleID"
            ? bundle.includes(pattern)
            : title.includes(pattern);
      if (matches) {
        return {
          category: rule.category,
          source: this.userRuleIDs.has(rule.id)
            ? "userRule"
            : this.catalogBacked
              ? "catalogRule"
              : "fallbackRule",
          ruleID: rule.id,
        };
      }
    }
    return { category: "ignore", source: "unmatched" };
  }
}

export const loadCatalogEntries = async (): Promise<ClassificationCatalogEntry[]> => {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}AppClassificationCatalog.json`);
    if (!response.ok) return [];
    const entries = (await response.json()) as ClassificationCatalogEntry[];
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
};

export const makeClassificationRule = (
  pattern: string,
  matchKind: ClassificationRule["matchKind"],
  category: ActivityCategory,
  priority = 9_000,
): ClassificationRule => ({
  id: makeID("rule"),
  pattern: pattern.trim(),
  matchKind,
  category,
  priority,
});

export const fallbackClassificationRules = fallbackRules;
