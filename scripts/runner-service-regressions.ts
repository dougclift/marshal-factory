import "./test-guard";
import assert from "node:assert/strict";
import { renderRunnerUnit, renderT3Unit, runnerLogPath, unitRestartRequired } from "../lib/runner-service";

assert.equal(runnerLogPath("darwin", "/Users/me"), "/Users/me/Library/Logs/marshal-factory/runner.log", "macOS keeps the launchd log path");
assert.equal(runnerLogPath("linux", "/home/me"), "/home/me/.local/state/marshal-factory/runner.log", "linux appends under the state dir");
assert.throws(() => runnerLogPath("freebsd", "/tmp"), /not freebsd|supports macOS and Linux/);

const env = { path: "/home/me/.bun/bin:/usr/bin:/bin", home: "/home/me", t3: "/home/me/.t3/bin/t3" };
const unit = renderRunnerUnit({ checkout: "/home/me/code/marshal-factory", bun: "/home/me/.bun/bin/bun", logPath: runnerLogPath("linux", "/home/me"), env });
assert.match(unit, /WorkingDirectory=\/home\/me\/code\/marshal-factory/);
assert.match(unit, /ExecStart="\/home\/me\/\.bun\/bin\/bun" "\/home\/me\/code\/marshal-factory\/runner\/index\.ts"/);
assert.match(unit, /Restart=always\nRestartSec=10/);
assert.match(unit, /Environment="PATH=\/home\/me\/\.bun\/bin:\/usr\/bin:\/bin"/);
assert.match(unit, /Environment="HOME=\/home\/me"/);
assert.match(unit, /Environment="T3CODE_CLI_PATH=\/home\/me\/\.t3\/bin\/t3"/);
assert.equal(unit.match(/^Environment=/gm)?.length, 3, "the unit sets PATH, HOME and T3CODE_CLI_PATH and nothing else");
assert.match(unit, /StandardOutput=append:\/home\/me\/\.local\/state\/marshal-factory\/runner\.log/);
assert.match(unit, /StandardError=append:\/home\/me\/\.local\/state\/marshal-factory\/runner\.log/);
assert.match(unit, /WantedBy=default\.target/);
assert.doesNotMatch(unit, /SECRET|TOKEN|DATABASE_URL/);

const noT3 = renderRunnerUnit({ checkout: "/home/me/code/marshal-factory", bun: "/usr/bin/bun", logPath: runnerLogPath("linux", "/home/me"), env: { path: "/usr/bin:/bin", home: "/home/me" } });
assert.equal(noT3.match(/^Environment=/gm)?.length, 2, "Modal-only omits T3CODE_CLI_PATH when t3 is not installed");
assert.match(renderRunnerUnit({ checkout: "/home/me/code/marshal-factory", bun: "/usr/bin/bun", logPath: "/home/me/log%.log", env: { path: "/usr/bin", home: "/home/me" } }), /StandardOutput=append:"\/home\/me\/log%%\.log"/, "a % in a path cannot become a systemd specifier");

const t3 = renderT3Unit({ t3: "/home/me/.t3/bin/t3", logPath: "/home/me/.local/state/marshal-factory/t3.log", env });
assert.match(t3, /ExecStart="\/home\/me\/\.t3\/bin\/t3" "serve" "--host" "127\.0\.0\.1"/);
assert.match(t3, /Restart=always\nRestartSec=10/);
assert.match(t3, /StandardOutput=append:\/home\/me\/\.local\/state\/marshal-factory\/t3\.log/);
assert.match(t3, /StandardError=append:\/home\/me\/\.local\/state\/marshal-factory\/t3\.log/);

assert.equal(unitRestartRequired(false, true), false, "an unchanged unit does not restart a running service");
assert.equal(unitRestartRequired(true, false), false, "a new unit is started by enable --now, not restarted");
assert.equal(unitRestartRequired(true, true), true, "a changed unit restarts the running service");
assert.equal(unitRestartRequired(false, false), false);

console.log("runner service regressions passed");
