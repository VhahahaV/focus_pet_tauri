import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [platform, target] = process.argv.slice(2);
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
if (JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version !== version) throw new Error("Application version mismatch");
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error("Tag does not match application version");
const root = join("src-tauri", "target", target, "release", "bundle");
const out = join("output", "release-apps");
mkdirSync(out, { recursive: true });
const outputFile = (extension) => join(out, `Focus-Pet-${version}-${platform}${extension}`);
const copyMatching = (directory, extension, suffix) => {
  const candidates = readdirSync(join(root, directory)).filter((name) => name.endsWith(extension));
  if (candidates.length !== 1) throw new Error(`Expected one ${extension} in ${directory}, found ${candidates.length}`);
  copyFileSync(join(root, directory, candidates[0]), outputFile(suffix));
};
if (platform.startsWith("macos-")) {
  const app = join(root, "macos", "Focus Pet.app");
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const stage = join("output", `dmg-${platform}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  execFileSync("ditto", [app, join(stage, "Focus Pet.app")]);
  symlinkSync("/Applications", join(stage, "Applications"));
  execFileSync("hdiutil", ["create", "-volname", `Focus Pet ${version}`, "-srcfolder", stage, "-ov", "-format", "UDZO", outputFile(".dmg")], { stdio: "inherit" });
  execFileSync("hdiutil", ["verify", outputFile(".dmg")], { stdio: "inherit" });
} else if (platform === "windows-x64") {
  copyMatching("nsis", ".exe", "-setup.exe");
} else if (platform === "linux-x64") {
  copyMatching("appimage", ".AppImage", ".AppImage");
  copyMatching("deb", ".deb", ".deb");
} else throw new Error(`Unsupported platform: ${platform}`);
for (const name of readdirSync(out).filter((name) => !name.endsWith(".sha256"))) {
  const hash = createHash("sha256").update(readFileSync(join(out, name))).digest("hex");
  writeFileSync(join(out, `${name}.sha256`), `${hash}  ${name}\n`);
}
