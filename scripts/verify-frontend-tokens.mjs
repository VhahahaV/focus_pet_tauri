import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as csstree from "css-tree";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [join(projectRoot, "src")];
const tokenFiles = new Set([
  join(projectRoot, "src", "styles", "tokens.css"),
  join(projectRoot, "src", "styles", "themes.css"),
]);
const rawHexPattern = /#[\da-f]{3,8}\b/gi;
const failures = [];
const cssFiles = [];
const selectorOwners = new Map();

const visit = (path) => {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) visit(join(path, name));
    return;
  }
  if (!/\.(?:css|tsx?)$/.test(path)) return;
  if (path.endsWith(".css")) cssFiles.push(path);
  if (tokenFiles.has(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const matches = line.match(rawHexPattern);
    if (matches) failures.push(`${relative(projectRoot, path)}:${index + 1} ${matches.join(", ")}`);
  });
};

for (const root of roots) visit(root);

for (const legacyPath of ["src/App.css", "src/design-v2.css"]) {
  if (existsSync(join(projectRoot, legacyPath))) failures.push(`${legacyPath} must be deleted after cascade consolidation`);
}

for (const path of cssFiles) {
  const source = readFileSync(path, "utf8");
  const file = relative(projectRoot, path);
  try {
    const ast = csstree.parse(source, { filename: file, positions: true });
    csstree.walk(ast, {
      visit: "Rule",
      enter(node) {
        if (node.prelude?.type !== "SelectorList") return;
        node.prelude.children.forEach((selectorNode) => {
          const selector = csstree.generate(selectorNode);
          const owners = selectorOwners.get(selector) ?? new Set();
          owners.add(file);
          selectorOwners.set(selector, owners);
        });
      },
    });
  } catch (error) {
    failures.push(`${file} is not valid CSS: ${error.message}`);
    continue;
  }

  source.split(/\r?\n/).forEach((line, index) => {
    if (line.includes("!important") && !line.includes("prefers-reduced-")) {
      failures.push(`${file}:${index + 1} !important is only allowed in reduced-motion/transparency fallbacks`);
    }
  });
}

for (const [selector, owners] of selectorOwners) {
  if (selector !== ":root" && owners.size > 1) failures.push(`selector spans multiple style modules: ${selector} (${[...owners].join(", ")})`);
}

if (failures.length > 0) {
  console.error("Frontend design-system verification failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("ok - frontend CSS is valid, tokenized, and legacy stylesheets are absent");
