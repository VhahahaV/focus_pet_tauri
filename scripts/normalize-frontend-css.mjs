import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as csstree from "css-tree";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = ["base", "primitives", "charts", "shell", "today", "history", "pet", "settings", "widgets"];
const files = modules.map((name) => ({ name, path: join(projectRoot, "src", "styles", `${name}.css`) }));
const asts = new Map(files.map(({ name, path }) => [name, csstree.parse(readFileSync(path, "utf8"))]));
const selectorOwners = new Map();

for (const { name } of files) {
  csstree.walk(asts.get(name), {
    visit: "Rule",
    enter(node) {
      if (node.prelude?.type !== "SelectorList") return;
      node.prelude.children.forEach((selector) => {
        const key = csstree.generate(selector);
        const owners = selectorOwners.get(key) ?? new Set();
        owners.add(name);
        selectorOwners.set(key, owners);
      });
    },
  });
}

const classifiedModule = (selector) => {
  if (/^\.fp-(?:filled-pie|pie-|progress-ring|status-timeline|input-columns|chart-frame|hourly-bars|heatmap)/.test(selector)) return "charts";
  if (/(?:widget|menu-bar|menu-|pet-companion|pet-hover-panel|pet-status-bubble|pet-bubble)/.test(selector)) return "widgets";
  if (/(?:settings|recognition|permission|rule-form|session-input|diagnostic|command-button|control-panel)/.test(selector)) return "settings";
  if (/(?:swift-pet|pet-settings|pet-pack|pet-import|pet-placement|pet-slider|pet-toggle|pet-validation|pet-section|random-action)/.test(selector)) return "pet";
  if (/(?:history|activity-|heatmap|sessions|attention)/.test(selector)) return "history";
  if (/(?:swift-today|today-|timeline|focus-card|focus-duration|window-picker|rhythm|app-track|app-segment|input-bars|state-track|state-block|system-monitor)/.test(selector)) return "today";
  if (/(?:sidebar|workspace|brand-mark|nav-|toast|install|app-shell|main-shell|floating-refresh|dock)/.test(selector)) return "shell";
  if (/^\.fp-/.test(selector)) return "primitives";
  if (/^(?:\*|html|body|#root|button|input|select|a|::selection|:root)/.test(selector)) return "base";
  return undefined;
};

const destinationFor = (selector, source) => {
  const classified = classifiedModule(selector);
  if (classified) return classified;
  return (selectorOwners.get(selector)?.size ?? 0) > 1 ? "primitives" : source;
};

const output = new Map(modules.map((name) => [name, []]));
const wrap = (css, wrappers) => wrappers.reduceRight((inner, wrapper) => `@${wrapper.name}${wrapper.prelude ? ` ${wrapper.prelude}` : ""}{${inner}}`, css);

const routeChildren = (children, source, wrappers = []) => {
  children.forEach((node) => {
    if (node.type === "Rule" && node.prelude?.type === "SelectorList") {
      node.prelude.children.forEach((selectorNode) => {
        const selector = csstree.generate(selectorNode);
        output.get(destinationFor(selector, source)).push(wrap(`${selector}${csstree.generate(node.block)}`, wrappers));
      });
      return;
    }
    if (node.type === "Atrule" && node.block?.children && ["media", "supports", "container", "layer", "starting-style"].includes(node.name)) {
      routeChildren(node.block.children, source, [...wrappers, { name: node.name, prelude: node.prelude ? csstree.generate(node.prelude) : "" }]);
      return;
    }
    output.get(source).push(wrap(csstree.generate(node), wrappers));
  });
};

for (const { name } of files) routeChildren(asts.get(name).children, name);

if (!process.argv.includes("--write")) {
  const duplicates = [...selectorOwners].filter(([selector, owners]) => selector !== ":root" && owners.size > 1);
  if (duplicates.length === 0) {
    console.log("ok - every selector is owned by one frontend style module");
    process.exit(0);
  }
  console.error(`${duplicates.length} selectors span multiple style modules; run with --write to normalize ownership`);
  process.exit(1);
}

for (const { name, path } of files) {
  writeFileSync(path, `/* ${name}.css — normalized design-system module. */\n${output.get(name).join("\n\n")}\n`);
}

console.log("ok - normalized frontend selector ownership");
