import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// This observes the installed application's real counters. It never synthesizes input.
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const seconds = Number(option("--seconds") ?? 20);
const keys = option("--keys");
const clicks = option("--clicks");
const output = option("--output");
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 300) throw new Error("--seconds must be between 5 and 300");
if (process.platform !== "darwin") throw new Error("This installed-app calibration is currently for macOS.");
const path = join(homedir(), "Library", "Application Support", "Focus Pet", "input-diagnostics.json");
const read = async () => {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (Date.now() - Date.parse(value.input.timestamp) > 10_000) throw new Error("Focus Pet sampling is stale. Start the installed app first.");
  if (value.input.inputMonitoringStatus !== "available") throw new Error("Input monitoring is unavailable. Enable Focus Pet in macOS Input Monitoring and restart it.");
  return value;
};
console.log("Prepare: keep hands off the keyboard and mouse for 5 seconds.");
await sleep(5_000);
const baseline = await read();
console.log(`START: ${seconds} seconds. Use physical keys and mouse clicks only. Do not type a reply until END.`);
let latest = baseline;
const deadline = Date.now() + (seconds + 10) * 1000;
while (Date.parse(latest.input.timestamp) - Date.parse(baseline.input.timestamp) < seconds * 1000) {
  if (Date.now() > deadline) throw new Error("Sampling did not advance in time");
  await sleep(200);
  latest = await read();
  if (latest.input.processID !== baseline.input.processID) throw new Error("App restarted during calibration");
}
const keyboard = latest.input.keyboardTotal - baseline.input.keyboardTotal;
const pointer = latest.input.pointerTotal - baseline.input.pointerTotal;
const report = {
  source: "installed-app physical input counters", start: baseline.input.timestamp, end: latest.input.timestamp,
  keyboard, mouseClicks: pointer,
  expectedKeyboard: keys === undefined ? null : Number(keys), expectedMouseClicks: clicks === undefined ? null : Number(clicks),
  matches: keys === undefined && clicks === undefined ? null : (keys === undefined || keyboard === Number(keys)) && (clicks === undefined || pointer === Number(clicks)),
};
console.log("END");
console.log(JSON.stringify(report, null, 2));
if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
if (report.matches === false) process.exitCode = 1;
