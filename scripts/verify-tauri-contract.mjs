import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readText = (path) => readFileSync(join(projectRoot, path), "utf8");
const readJSON = (path) => JSON.parse(readText(path));

const unique = (values) => [...new Set(values)];
const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));

const extractRustCommands = () => {
  const lib = readText("src-tauri/src/lib.rs");
  const handler = lib.match(/generate_handler!\s*\[([\s\S]*?)\]/)?.[1];
  if (!handler) throw new Error("Unable to find tauri::generate_handler command list");
  return unique(
    [...handler.matchAll(/\b([a-z][a-z0-9_]*)\b/g)]
      .map((match) => match[1])
      .filter((name) => !["tauri", "generate_handler"].includes(name)),
  );
};

const extractFrontendInvokes = () => {
  const source = readText("src/store/native.ts");
  return unique(
    [...source.matchAll(/invoke(?:<[^>]+>)?\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
  );
};

const diff = (left, right) => sorted(left.filter((value) => !right.includes(value)));

const requiredCommands = [
  "load_snapshot",
  "save_snapshot",
  "export_snapshot",
  "delete_all_data",
  "quit_app",
  "data_size",
  "sample_activity",
  "permission_snapshot",
  "installation_snapshot",
  "open_system_settings",
  "open_log_folder",
  "current_log_file",
  "choose_and_import_pet_pack",
  "import_pet_pack_from_path",
  "list_pet_packs",
  "delete_pet_pack",
  "deliver_notification",
  "sync_widget_windows",
];

const requiredWindows = [
  "main",
  "widget-menu-bar",
  "widget-current-status",
  "widget-recent-rhythm",
  "widget-pet-companion",
];

const requiredCorePermissions = [
  "core:default",
  "core:window:allow-start-dragging",
  "core:window:allow-set-position",
  "core:window:allow-outer-position",
];

const checks = [];
const addCheck = (name, run) => checks.push({ name, run });

addCheck("frontend invoke commands match Rust generate_handler commands", () => {
  const rustCommands = extractRustCommands();
  const frontendCommands = extractFrontendInvokes();
  const missingInRust = diff(frontendCommands, rustCommands);
  const unusedByFrontend = diff(rustCommands, frontendCommands);
  if (missingInRust.length || unusedByFrontend.length) {
    throw new Error(
      [
        missingInRust.length ? `missing in Rust: ${missingInRust.join(", ")}` : "",
        unusedByFrontend.length ? `not invoked by frontend: ${unusedByFrontend.join(", ")}` : "",
      ].filter(Boolean).join("; "),
    );
  }
  return true;
});

addCheck("required custom command surface is complete", () => {
  const rustCommands = extractRustCommands();
  const frontendCommands = extractFrontendInvokes();
  const missing = diff(requiredCommands, rustCommands).concat(diff(requiredCommands, frontendCommands));
  if (missing.length) throw new Error(`missing required commands: ${unique(missing).join(", ")}`);
  return true;
});

addCheck("capability covers all Focus Pet webview windows", () => {
  const capability = readJSON("src-tauri/capabilities/default.json");
  const missing = diff(requiredWindows, capability.windows ?? []);
  if (missing.length) throw new Error(`missing capability windows: ${missing.join(", ")}`);
  return true;
});

addCheck("capability includes widget movement and event permissions", () => {
  const capability = readJSON("src-tauri/capabilities/default.json");
  const permissions = capability.permissions ?? [];
  const missing = diff(requiredCorePermissions, permissions);
  if (missing.length) throw new Error(`missing capability permissions: ${missing.join(", ")}`);
  return true;
});

addCheck("Tauri asset protocol is scoped for imported pet-pack media", () => {
  const config = readJSON("src-tauri/tauri.conf.json");
  const asset = config.app?.security?.assetProtocol;
  if (!asset?.enable) throw new Error("asset protocol is not enabled");
  const scope = asset.scope ?? [];
  for (const required of ["$APPDATA/**", "$LOCALDATA/**", "$HOME/**"]) {
    if (!scope.includes(required)) throw new Error(`asset protocol missing scope ${required}`);
  }
  const csp = config.app?.security?.csp ?? "";
  for (const required of ["asset:", "http://asset.localhost"]) {
    if (!csp.includes(required)) throw new Error(`CSP missing ${required}`);
  }
  return true;
});

addCheck("widget labels and event channels are wired in Rust and React", () => {
  const lib = readText("src-tauri/src/lib.rs");
  const widgetView = readText("src/components/WidgetView.tsx");
  const petCompanion = readText("src/components/PetCompanion.tsx");
  const useApp = readText("src/app/useFocusPetApp.ts");
  for (const label of requiredWindows.slice(1)) {
    if (!lib.includes(label)) throw new Error(`Rust widget sync missing ${label}`);
  }
  for (const eventName of [
    "focus-pet-widget-state",
    "focus-pet-widget-moved",
    "focus-pet-companion-state",
    "focus-pet-companion-moved",
    "focus-pet-native-menu",
  ]) {
    const haystack = `${lib}\n${widgetView}\n${petCompanion}\n${useApp}`;
    if (!haystack.includes(eventName)) throw new Error(`event channel missing ${eventName}`);
  }
  return true;
});

let failed = 0;
console.log("==> Focus Pet Tauri contract audit");
for (const check of checks) {
  try {
    check.run();
    console.log(`ok - ${check.name}`);
  } catch (error) {
    failed += 1;
    console.log(`fail - ${check.name}`);
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\nTauri contract audit failed: ${failed} check(s) failed.`);
  process.exit(1);
}
