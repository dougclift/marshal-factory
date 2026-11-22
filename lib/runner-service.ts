import { homedir } from "node:os";
import { join } from "node:path";

// Paths and unit text the runner's service install shares. macOS uses launchd; Linux uses a systemd
// user unit. Both append the runner's stdout and stderr to the path below, and neither unit carries
// secrets: the runner loads .env.local from the checkout itself.

/** Where the service manager appends the runner's stdout and stderr. */
export function runnerLogPath(platform = process.platform, home = homedir()): string {
  if (platform === "darwin") return join(home, "Library/Logs/marshal-factory/runner.log");
  if (platform === "linux") return join(home, ".local/state/marshal-factory/runner.log");
  throw new Error(`marshal-factory's runner supports macOS and Linux, not ${platform}`);
}

export const RUNNER_SERVICE = "marshal-factory-runner.service";
export const T3_SERVICE = "marshal-factory-t3.service";

/** PATH, HOME and, when the t3 binary was found, T3CODE_CLI_PATH. The same three the macOS plist sets. */
export type UnitEnv = { path: string; home: string; t3?: string };

/** Restart a user service only when its unit file changed and it was already running. */
export const unitRestartRequired = (changed: boolean, wasActive: boolean) => changed && wasActive;

/**
 * `--uninstall` removes the runner unit. The T3 unit stays, so a rollout that stops and reinstalls
 * the runner without `--with-t3` does not drop `t3 serve`. Pass `--with-t3` to remove that unit too.
 */
export function unitsToUninstall(withT3: boolean) {
  return withT3 ? [RUNNER_SERVICE, T3_SERVICE] : [RUNNER_SERVICE];
}

const escapeSystemd = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
const quote = (value: string) => `"${escapeSystemd(value)}"`;
const safePath = (value: string) => /^[A-Za-z0-9._/@+-]+$/.test(value);

function environmentLines(env: UnitEnv) {
  const lines = [`Environment=${quote(`PATH=${env.path}`)}`, `Environment=${quote(`HOME=${env.home}`)}`];
  if (env.t3) lines.push(`Environment=${quote(`T3CODE_CLI_PATH=${env.t3}`)}`);
  return lines;
}

function setting(key: string, value: string) {
  return `${key}=${safePath(value) ? value : quote(value)}`;
}

function append(key: string, path: string) {
  return `${key}=append:${safePath(path) ? path : quote(path)}`;
}

/** The user unit that runs `bun runner/index.ts` from the checkout. */
export function renderRunnerUnit({ checkout, bun, logPath, env }: { checkout: string; bun: string; logPath: string; env: UnitEnv }) {
  return `# The runner reads secrets from .env.local in WorkingDirectory. This unit sets none.
[Unit]
Description=marshal-factory runner

[Service]
${setting("WorkingDirectory", checkout)}
ExecStart=${quote(bun)} ${quote(join(checkout, "runner/index.ts"))}
Restart=always
RestartSec=10
${environmentLines(env).join("\n")}
${append("StandardOutput", logPath)}
${append("StandardError", logPath)}

[Install]
WantedBy=default.target
`;
}

/** The user unit that runs `t3 serve` on localhost, for jobs that run on this machine. */
export function renderT3Unit({ t3, logPath, env }: { t3: string; logPath: string; env: UnitEnv }) {
  return `# t3 serve for local factory jobs. The runner's unit stays free of secrets too.
[Unit]
Description=T3 Code server for marshal-factory

[Service]
${setting("WorkingDirectory", env.home)}
ExecStart=${quote(t3)} "serve" "--host" "127.0.0.1"
Restart=always
RestartSec=10
${environmentLines(env).join("\n")}
${append("StandardOutput", logPath)}
${append("StandardError", logPath)}

[Install]
WantedBy=default.target
`;
}
