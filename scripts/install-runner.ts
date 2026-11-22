import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { renderRunnerUnit, renderT3Unit, RUNNER_SERVICE, runnerLogPath, T3_SERVICE, unitRestartRequired, type UnitEnv } from "../lib/runner-service";

// Installs the runner so it stays up: a launchd LaunchAgent on macOS, a systemd user service on
// Linux. Both restart it when it exits and append its log to the per-OS path in lib/runner-service.ts.
// Re-running with nothing changed leaves the process alone. On Linux, --with-t3 also installs a
// user service that runs `t3 serve` for jobs that run on this machine.
//   bun scripts/install-runner.ts [--uninstall] [--with-t3]

export const LABEL = "com.marshal-factory.runner";

if (process.platform !== "darwin") {
  if (process.platform !== "linux") {
    console.error(`marshal-factory's runner installs on macOS and Linux, not ${process.platform}.`);
    process.exit(1);
  }
  linuxMain();
}

if (process.platform === "darwin" && process.argv.includes("--with-t3") && !process.argv.includes("--uninstall")) {
  console.error("`--with-t3` installs a systemd user service for `t3 serve` and only applies on Linux.");
  process.exit(1);
}

const root = join(import.meta.dirname, "..");
const plistPath = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const logPath = runnerLogPath();
const domain = `gui/${userInfo().uid}`;

const which = (bin: string) => execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();
const launchctl = (...args: string[]) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: "pipe" });
const loaded = () => {
  try {
    launchctl("print", `${domain}/${LABEL}`);
    return true;
  } catch {
    return false;
  }
};

if (process.platform === "darwin" && process.argv.includes("--uninstall")) {
  if (loaded()) launchctl("bootout", `${domain}/${LABEL}`);
  console.log(`unloaded  ${LABEL}; ${plistPath} left in place`);
  process.exit(0);
}

if (process.platform === "darwin") {
  // launchd starts with a bare PATH, so carry the directories of every tool the runner calls.
  const tools = ["bun", "git"].map(which);
  // T3 exports its CLI path only to sessions it starts; the daemon gets it from here.
  // T3 installs its launcher at ~/.t3/bin/t3 and puts it on the login shell's PATH; launchd has neither.
  const t3 = process.env.T3CODE_CLI_PATH ?? [join(homedir(), ".t3/bin/t3")].find(existsSync) ?? which("t3");
  const path = [...new Set([...tools.map(dirname), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${escape(tools[0]!)}</string><string>${escape(join(root, "runner/index.ts"))}</string></array>
  <key>WorkingDirectory</key><string>${escape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(path)}</string>
    <key>HOME</key><string>${escape(homedir())}</string>
    <key>T3CODE_CLI_PATH</key><string>${escape(t3)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(logPath)}</string>
</dict>
</plist>
`;

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  const changed = !existsSync(plistPath) || readFileSync(plistPath, "utf8") !== plist;
  if (changed) writeFileSync(plistPath, plist);
  if (changed && loaded()) {
    launchctl("bootout", `${domain}/${LABEL}`);
    // bootout returns before the old process is gone; bootstrap fails until it is.
    for (let i = 0; i < 50 && loaded(); i++) execFileSync("/bin/sleep", ["0.2"]);
  }
  const wasLoaded = loaded();
  if (changed || !wasLoaded) launchctl("bootstrap", domain, plistPath);
  console.log(`${changed ? "installed" : wasLoaded ? "unchanged" : "loaded"} ${LABEL}; log ${logPath}`);
}

function linuxWhich(bin: string) {
  try {
    return execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function systemctl(args: string[], tolerate?: RegExp): void {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if ((result.status ?? 1) === 0) return;
  const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim() || result.error?.message || "";
  if (tolerate && tolerate.test(detail)) return;
  const bus = /Failed to connect to bus|not been booted with systemd/.test(detail);
  fail(
    `systemctl --user ${args.join(" ")} failed${detail ? `: ${detail}` : ""}${bus ? "\nA user service needs a systemd user session. Log in as the runner user, not root, so XDG_RUNTIME_DIR is set." : ""}`,
  );
}

function isActive(unit: string) {
  const result = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" });
  return result.stdout.trim() === "active";
}

function unitPath(name: string) {
  return join(homedir(), ".config/systemd/user", name);
}

function writeUnit(name: string, text: string) {
  const path = unitPath(name);
  mkdirSync(dirname(path), { recursive: true });
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== text;
  const wasActive = isActive(name);
  if (changed) writeFileSync(path, text);
  return { name, changed, wasActive };
}

function applyUnit(written: { name: string; changed: boolean; wasActive: boolean }, log: string) {
  systemctl(["enable", "--now", written.name]);
  if (unitRestartRequired(written.changed, written.wasActive)) systemctl(["restart", written.name]);
  const verb = written.changed ? "installed" : written.wasActive ? "unchanged" : "started";
  console.log(`${verb} ${written.name}; log ${log}`);
}

function removeUnit(name: string) {
  const path = unitPath(name);
  const present = existsSync(path);
  systemctl(["disable", "--now", name], /does not exist|not loaded|not found/i);
  if (present) rmSync(path);
  return present;
}

function linuxMain(): never {
  const uninstall = process.argv.includes("--uninstall");
  const withT3 = process.argv.includes("--with-t3");
  if (uninstall) {
    const runner = removeUnit(RUNNER_SERVICE);
    const t3 = removeUnit(T3_SERVICE);
    systemctl(["daemon-reload"]);
    spawnSync("systemctl", ["--user", "reset-failed", RUNNER_SERVICE, T3_SERVICE], { encoding: "utf8" });
    const names = [runner ? RUNNER_SERVICE : undefined, t3 ? T3_SERVICE : undefined].filter(Boolean);
    console.log(names.length > 0 ? `stopped and removed ${names.join(" and ")}` : `no ${RUNNER_SERVICE} unit was installed`);
    process.exit(0);
  }

  const checkout = join(import.meta.dirname, "..");
  const bun = linuxWhich("bun");
  const git = linuxWhich("git");
  if (!bun) fail("`bun` was not found on PATH. Install Bun and run this again.");
  if (!git) fail("`git` was not found on PATH. Install git and run this again.");
  const home = homedir();
  const t3 = process.env.T3CODE_CLI_PATH ?? [join(home, ".t3/bin/t3")].find(existsSync) ?? linuxWhich("t3");
  if (withT3 && !t3) fail("`--with-t3` needs the t3 command. Install T3, or set T3CODE_CLI_PATH.");
  const pathEnv = [...new Set([dirname(bun), dirname(git), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  const env: UnitEnv = { path: pathEnv, home, ...(t3 ? { t3 } : {}) };
  const logPath = runnerLogPath();
  const t3LogPath = join(dirname(logPath), "t3.log");
  mkdirSync(dirname(logPath), { recursive: true });

  const t3Unit = withT3 ? writeUnit(T3_SERVICE, renderT3Unit({ t3: t3!, logPath: t3LogPath, env })) : undefined;
  const runnerUnit = writeUnit(RUNNER_SERVICE, renderRunnerUnit({ checkout, bun, logPath, env }));
  systemctl(["daemon-reload"]);
  if (t3Unit) applyUnit(t3Unit, t3LogPath);
  applyUnit(runnerUnit, logPath);
  if (!t3) console.log("T3CODE_CLI_PATH was not set; t3 was not found. Modal-only does not need it.");

  const user = userInfo().username;
  const linger = spawnSync("loginctl", ["show-user", user, "--property=Linger", "--value"], { encoding: "utf8" });
  if (linger.status !== 0 || linger.stdout.trim() !== "yes") {
    console.log(`hint: linger is off, so this user service stops at logout. Keep it running with: sudo loginctl enable-linger ${user}`);
  }
  process.exit(0);
}
