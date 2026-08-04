import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = process.env.FOCUS_PET_SWIFT_ROOT
  ? resolve(process.env.FOCUS_PET_SWIFT_ROOT)
  : resolve(projectRoot, "..", "focus_pet");

const checks = [];

const addCheck = (name, run, options = {}) => {
  checks.push({ name, run, optional: options.optional === true });
};

const pathFromRoot = (root, path) => join(root, path);

const fileText = (path) => readFileSync(path, "utf8");

const hasFile = (root, path) => existsSync(pathFromRoot(root, path)) && statSync(pathFromRoot(root, path)).isFile();

const hasDir = (root, path) => existsSync(pathFromRoot(root, path)) && statSync(pathFromRoot(root, path)).isDirectory();

const contains = (root, path, snippets) => {
  const text = fileText(pathFromRoot(root, path));
  return snippets.every((snippet) => text.includes(snippet));
};

const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const sameHash = (left, right) => hashFile(left) === hashFile(right);

const jsonFile = (path) => JSON.parse(fileText(path));

const listZipFiles = (root, path) =>
  readdirSync(pathFromRoot(root, path)).filter((name) => name.toLowerCase().endsWith(".zip")).sort();

const sourceExists = hasDir(sourceRoot, "Sources");

const requireFiles = (root, files) => files.every((path) => hasFile(root, path));

const requireDirs = (root, dirs) => dirs.every((path) => hasDir(root, path));

addCheck("React/Tauri target structure exists", () =>
  requireFiles(projectRoot, [
    "package.json",
    "vite.config.ts",
    "src/main.tsx",
    "src/App.tsx",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
    "src-tauri/src/lib.rs",
  ]) &&
  requireDirs(projectRoot, [
    "src/core",
    "src/app",
    "src/components",
    "src/resources",
    "src/store",
    "src-tauri/src/native",
  ]),
);

addCheck("core Swift modules have React equivalents", () =>
  requireFiles(projectRoot, [
    "src/core/activity.ts",
    "src/core/classification.ts",
    "src/core/settings.ts",
    "src/core/stateEngine.ts",
    "src/core/timeline.ts",
    "src/core/summary.ts",
    "src/core/sessions.ts",
    "src/core/nudge.ts",
    "src/core/pet.ts",
    "src/core/types.ts",
    "src/store/localStore.ts",
  ]) &&
  contains(projectRoot, "src/core/types.ts", [
    "isSystemSleeping",
    "isScreenLocked",
  ]) &&
  contains(projectRoot, "src/core/stateEngine.ts", [
    "longInputIdleAway",
    "entertainmentStable",
    "recentInputRecovery",
  ]) &&
  contains(projectRoot, "src/core/settings.ts", [
    "idleAwaySeconds",
    "randomActionSwitchSeconds",
  ]),
);

addCheck("runtime orchestration migrated from FocusPetModel", () =>
  requireFiles(projectRoot, [
    "src/app/useFocusPetApp.ts",
    "src/app/runtime.ts",
    "src/app/nativeMenu.ts",
    "src/app/widgetWindows.ts",
    "src/app/petCompanionLogic.ts",
  ]) &&
  contains(projectRoot, "src/app/useFocusPetApp.ts", [
    "nativeActivitySample",
    "nativeInstallationSnapshot",
    "nativeRuntimeSnapshot",
    "nativeSyncWidgetWindows",
    "nativeImportPetPack",
    "nativeDeliverNotification",
    "refreshRecognitionDiagnostics",
  ]),
);

addCheck("UI surfaces migrated to React components", () =>
  requireFiles(projectRoot, [
    "src/components/AppShell.tsx",
    "src/components/TodayTab.tsx",
    "src/components/SessionsTab.tsx",
    "src/components/PetTab.tsx",
    "src/components/SettingsTab.tsx",
    "src/components/WidgetView.tsx",
    "src/components/MenuBarView.tsx",
    "src/components/PetCompanion.tsx",
  ]) &&
  contains(projectRoot, "tests/e2e/dashboard.spec.ts", [
    "Swift-style shell and Today surface render",
    "computer monitor can be customized and keeps the Today cards aligned",
    "desktop widget views render without the main runtime shell",
    "settings expose all modules without a secondary navigation rail",
    "pet settings expose hover and random action controls",
  ]),
);

addCheck("Tauri commands cover original native/storage feature surface", () =>
  contains(projectRoot, "src-tauri/src/lib.rs", [
    "load_snapshot",
    "save_snapshot",
    "native_runtime_snapshot",
    "sample_activity",
    "sample_system_metrics",
    "installation_snapshot",
    "choose_and_import_pet_pack",
    "import_pet_pack_from_path",
    "list_pet_packs",
    "pet_pack_assets",
    "delete_pet_pack",
    "deliver_notification",
    "sync_widget_windows",
  ]) &&
  contains(projectRoot, "src/store/native.ts", [
    'invoke<LocalStoreSnapshot>("load_snapshot")',
    'invoke<NativeActivitySample>("sample_activity")',
    'invoke<PetPackRecord[]>("import_pet_pack_from_path"',
    'invoke<boolean>("sync_widget_windows"',
  ]),
);

addCheck("macOS, Windows, and Linux native adapters are separated", () =>
  requireFiles(projectRoot, [
    "src-tauri/src/native/macos.rs",
    "src-tauri/src/native/windows.rs",
    "src-tauri/src/native/linux.rs",
    "src-tauri/src/native/mod.rs",
    "src-tauri/src/notifications.rs",
  ]) &&
  contains(projectRoot, "src-tauri/src/native/macos.rs", [
    "osascript",
    "IOHIDSystem",
    "CGEventSourceSecondsSinceLastEventType",
    "needs-accessibility-permission",
  ]) &&
  contains(projectRoot, "src-tauri/src/native/windows.rs", [
    "GetForegroundWindow",
    "GetLastInputInfo",
  ]) &&
  contains(projectRoot, "src-tauri/src/native/linux.rs", [
    "xdotool",
    "xprop",
    "xprintidle",
    "wayland-limited",
  ]) &&
  contains(projectRoot, "src-tauri/src/notifications.rs", [
    "display notification",
    "New-BurntToastNotification",
    "notify-send",
  ]),
);

addCheck("pet pack system and validation migrated", () =>
  requireFiles(projectRoot, [
    "src/resources/petPack.ts",
    "src-tauri/src/pet_pack.rs",
    "local-pet-packs/LuoXiaoHeiLocal.zip",
    "local-pet-packs/PixelCatMemeLocal.zip",
    "local-pet-packs/UNIkeNLocal.zip",
    "local-pet-packs/XiaoDaiLocal.zip",
    "local-pet-packs/FocusPetLocalPetPacks.zip",
  ]) &&
  contains(projectRoot, "src-tauri/src/pet_pack.rs", [
    "source_roots",
    "validate_pack_roots",
    "zip",
    "delete_pet_pack",
    "source_action_assets",
  ]) &&
  contains(projectRoot, "src/resources/petPack.ts", [
    "sourceActions",
    "idleSourceActionIDs",
    "resolveSourceActionForIntent",
    "demoPetPackRecords",
  ]) &&
  listZipFiles(projectRoot, "local-pet-packs").length >= 5,
);

addCheck("classification catalog and visual assets are present", () =>
  requireFiles(projectRoot, [
    "public/AppClassificationCatalog.json",
    "public/assets/AppIcon.png",
    "public/assets/StatusIcon.png",
    "public/assets/focus-pet-dashboard.png",
    "public/assets/focus-pet-today.png",
    "public/assets/focus-pet-widgets.png",
    "public/assets/pet-luo-xiaohei.png",
    "public/assets/pet-pixel-cat.png",
    "public/assets/pet-xiaodai.png",
  ]) &&
  Array.isArray(jsonFile(pathFromRoot(projectRoot, "public/AppClassificationCatalog.json"))) &&
  jsonFile(pathFromRoot(projectRoot, "public/AppClassificationCatalog.json")).length >= 40,
);

addCheck("original reference docs are carried into target folder", () =>
  requireFiles(projectRoot, [
    "docs/original-swift/classification-catalog-notes.md",
    "docs/original-swift/luoxiaohei-local-pack.md",
    "docs/original-swift/pet-action-module-design.md",
    "docs/original-swift/project-summary.md",
    "docs/original-swift/release-packaging.md",
    "docs/original-swift/widget-concepts/focus-pet-widgets.md",
  ]),
);

addCheck("automated verification entry points exist", () =>
  contains(projectRoot, "package.json", [
    '"build"',
    '"test"',
    '"test:ui"',
    '"verify:native"',
    '"verify:tauri-contract"',
    '"verify:preflight"',
    '"verify:platform"',
  ]) &&
  requireFiles(projectRoot, [
    "scripts/verify-platform.mjs",
    "scripts/verify-native-adapters.mjs",
    ".github/workflows/verify-platforms.yml",
    "docs/target-machine-validation.md",
  ]),
);

addCheck("source Swift project can be inspected for migration audit", () => sourceExists, { optional: true });

addCheck("classification catalog matches Swift source", () => {
  if (!sourceExists) return true;
  return sameHash(
    pathFromRoot(sourceRoot, "Sources/FocusPetCore/Resources/AppClassificationCatalog.json"),
    pathFromRoot(projectRoot, "public/AppClassificationCatalog.json"),
  );
});

addCheck("README visual assets match Swift source docs", () => {
  if (!sourceExists) return true;
  const pairs = [
    ["Sources/FocusPetMac/Resources/AppIcon.png", "public/assets/AppIcon.png"],
    ["Sources/FocusPetMac/Resources/StatusIcon.png", "public/assets/StatusIcon.png"],
    ["docs/readme-assets/focus-pet-dashboard.png", "public/assets/focus-pet-dashboard.png"],
    ["docs/readme-assets/focus-pet-today.png", "public/assets/focus-pet-today.png"],
    ["docs/readme-assets/focus-pet-widgets.png", "public/assets/focus-pet-widgets.png"],
    ["docs/readme-assets/pet-luo-xiaohei.png", "public/assets/pet-luo-xiaohei.png"],
    ["docs/readme-assets/pet-pixel-cat.png", "public/assets/pet-pixel-cat.png"],
    ["docs/readme-assets/pet-xiaodai.png", "public/assets/pet-xiaodai.png"],
  ];
  return pairs.every(([source, target]) => sameHash(pathFromRoot(sourceRoot, source), pathFromRoot(projectRoot, target)));
});

addCheck("local pet-pack archives match Swift release artifacts", () => {
  if (!sourceExists) return true;
  const pairs = [
    ["dist/local/PetPacks/LuoXiaoHeiLocal.zip", "local-pet-packs/LuoXiaoHeiLocal.zip"],
    ["dist/local/PetPacks/PixelCatMemeLocal.zip", "local-pet-packs/PixelCatMemeLocal.zip"],
    ["dist/local/PetPacks/UNIkeNLocal.zip", "local-pet-packs/UNIkeNLocal.zip"],
    ["dist/local/PetPacks/XiaoDaiLocal.zip", "local-pet-packs/XiaoDaiLocal.zip"],
    ["dist/local/FocusPetLocalPetPacks.zip", "local-pet-packs/FocusPetLocalPetPacks.zip"],
  ];
  return pairs.every(([source, target]) => sameHash(pathFromRoot(sourceRoot, source), pathFromRoot(projectRoot, target)));
});

let failed = 0;
let warned = 0;

console.log("==> Focus Pet migration completeness audit");
console.log(`Target: ${projectRoot}`);
console.log(`Swift source: ${sourceRoot}${sourceExists ? "" : " (not found)"}`);

for (const check of checks) {
  let ok = false;
  let error = "";
  try {
    ok = Boolean(check.run());
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const status = ok ? "ok" : check.optional ? "warn" : "fail";
  console.log(`${status} - ${check.name}`);
  if (error) console.log(`  ${error}`);
  if (!ok && check.optional) warned += 1;
  if (!ok && !check.optional) failed += 1;
}

if (failed > 0) {
  console.error(`\nMigration audit failed: ${failed} required check(s) failed.`);
  process.exit(1);
}

if (warned > 0) {
  console.warn(`\nMigration audit completed with ${warned} optional warning(s).`);
}
