import "./test-guard";
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { AgentRow, EventRow, JobRow, MachineRow, RunRow } from "../db/schema";
import type { BoardCard } from "../components/panel/cards";
import type { Feed } from "../components/panel/sealed";
import { useAfterHydration, useNow } from "../components/panel/time";

// Live feeds stay on the server snapshot. Run detail reads that flag when its module loads.
process.env.NEXT_PUBLIC_LIVE_UPDATES = "off";
process.env.NEON_AUTH_BASE_URL ??= "https://auth.invalid/neondb/auth";
process.env.NEON_AUTH_COOKIE_SECRET ??= "x".repeat(32);

// JobList's row keys call useRouter. The pin note does not; a stub keeps the mount off the app router.
mock.module("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const EPOCH = 1_700_000_000_000;
const SEEN_AT = new Date(EPOCH + 86_400_000);

function installDom() {
  const window = new Window({ url: "http://localhost:3000", width: 1280, height: 800 });
  const names = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "DocumentFragment",
    "SVGElement",
    "Text",
    "Comment",
    "MutationObserver",
    "ResizeObserver",
    "IntersectionObserver",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "getSelection",
    "Document",
    "Event",
    "CustomEvent",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
  ] as const;
  const host = globalThis as Record<string, unknown>;
  const browser = window as unknown as Record<string, unknown>;
  for (const name of names) host[name] = name === "window" ? window : browser[name];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return window;
}

/** A client mount, the path that crashes when getSnapshot changes on every call. */
async function mount(node: ReactElement) {
  const errors: unknown[] = [];
  const logged: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const report = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  let root: Root | undefined;
  try {
    root = createRoot(container, {
      onUncaughtError: (error) => errors.push(error),
      onCaughtError: (error) => errors.push(error),
    });
    await act(async () => {
      root?.render(node);
    });
  } catch (error) {
    errors.push(error);
  } finally {
    console.error = report;
  }
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  return {
    text: container.textContent ?? "",
    failed: [...errors.map(message), ...logged].join("\n"),
    async rerender(next: ReactElement) {
      await act(async () => {
        root?.render(next);
      });
      return container.textContent ?? "";
    },
    async cleanup() {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      container.remove();
    },
  };
}

function ClockProbe({ tick }: { tick: number }) {
  const now = useNow(60_000) ?? 0;
  return createElement("span", null, `${tick}:${now}`);
}

function UnstableClock() {
  const now = useAfterHydration(() => Date.now(), 0);
  return createElement("span", null, String(now));
}

const at = new Date(EPOCH);

function card(targetMachineId: string): BoardCard {
  return {
    id: "job-1",
    jobId: "queue:item-1",
    jobKey: "MF-1",
    title: "Pin the job",
    repo: "acme/app",
    stage: "queued",
    summary: null,
    question: null,
    prUrl: null,
    sourceLink: null,
    machineId: null,
    answeredAt: null,
    attempt: 1,
    attemptRuns: [],
    nudgedAt: null,
    latest: null,
    runs: [],
    harness: null,
    runsOn: null,
    targetMachineId,
    mergeDecision: null,
    evidence: null,
    stop: null,
    updatedAt: at,
  };
}

function machine(id: string, name: string): MachineRow {
  return { id, name, last_seen_at: SEEN_AT, heartbeat: {}, inventory: null, inventory_at: null };
}

function job(target: string): JobRow {
  return {
    id: "queue:item-1",
    source: "queue",
    external_id: "item-1",
    key: "MF-1",
    title: "Pin the job",
    url: "https://example.test/MF-1",
    description: null,
    repo: "acme/app",
    writeback: { kind: "queue", itemId: "item-1" },
    source_state: { state: null, labels: [] },
    stage: "queued",
    stage_at: null,
    stage_summary: null,
    question: null,
    pr_url: null,
    stage_event_id: null,
    synced_event_id: null,
    delivered_reply_ids: [],
    answered_at: null,
    answer: null,
    resume_context: null,
    attempt: 1,
    previous_failure: null,
    attempt_note: null,
    budget_usd: 5,
    nudged_at: null,
    nudged_stage: null,
    stop_sent_to: null,
    stop_event_id: null,
    stop: null,
    conflict_head: null,
    t3_thread_id: null,
    machine_id: null,
    provider: null,
    model: null,
    execution: null,
    target_machine: target,
    ticket_overrides: null,
    session_id: "session-1",
    sandbox_id: null,
    sandbox_snapshot: null,
    codex_slot: null,
    merge_assessment: null,
    assessment_event_id: null,
    merge_decision: null,
    evidence: null,
    dismissed_at: null,
    delivered_feedback_ids: [],
    archived_at: null,
    archived_by: null,
    claimed_at: at,
    updated_at: at,
  };
}

function run(): RunRow {
  return {
    session_id: "session-1",
    cwd: null,
    repo: "acme/app",
    branch: "factory/MF-1",
    job_key: "MF-1",
    t3_thread_id: null,
    title: "Pin the job",
    status: "active",
    stage: "queued",
    stage_at: null,
    stage_summary: null,
    question: null,
    pr_url: null,
    transcript_path: null,
    started_at: at,
    last_event_at: at,
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
}

const feed = <Row,>(): Feed<Row> => ({ initialData: [], sealedQuery: null });

const dom = installDom();
const realNow = Date.now;
// Every read is a new time, so a snapshot of Date.now() cannot be cached.
let clock = EPOCH;
Date.now = () => ++clock;

try {
  const { Board } = await import("../components/panel/board");
  const { JobList } = await import("../components/panel/job-list");
  const { RunDetail } = await import("../components/panel/run-detail");

  const pinned = card("bench");
  const machines = new Map([["bench", machine("bench", "bench")]]);
  const gone = card("gone");

  // Before hydration the clock is null, and targetNote treats 0 as "not ready": a missing machine is not "waiting" yet.
  const serverHtml = renderToString(
    createElement(Board, { cards: [gone], agentsBySession: new Map(), selected: undefined, machines: new Map() }),
  );
  assert.match(serverHtml, /Pinned to gone/, "the server render has no clock yet");
  assert.doesNotMatch(serverHtml, /Waiting on gone/, "a missing machine is not stale until the client clock starts");

  {
    const probe = await mount(createElement(ClockProbe, { tick: 1 }));
    assert.equal(probe.failed, "", probe.failed);
    const first = probe.text;
    const moved = Date.now();
    const second = await probe.rerender(createElement(ClockProbe, { tick: 2 }));
    assert.equal(second.split(":")[1], first.split(":")[1], "useNow returns the same instant until its interval fires");
    assert.ok(moved > Number(first.split(":")[1]), "the wall clock moved while the snapshot stayed");
    await probe.cleanup();
  }

  {
    const view = await mount(
      createElement(Board, { cards: [pinned], agentsBySession: new Map(), selected: undefined, machines }),
    );
    assert.equal(view.failed, "", view.failed);
    assert.match(view.text, /Pinned to bench/);
    await view.cleanup();
  }

  {
    const view = await mount(
      createElement(Board, { cards: [gone], agentsBySession: new Map(), selected: undefined, machines: new Map() }),
    );
    assert.equal(view.failed, "", view.failed);
    assert.match(view.text, /Waiting on gone/, "a client mount has a real clock, so a missing machine is waiting");
    await view.cleanup();
  }

  {
    const view = await mount(
      createElement(JobList, { cards: [pinned], agentsBySession: new Map(), selected: undefined, machines }),
    );
    assert.equal(view.failed, "", view.failed);
    assert.match(view.text, /Pinned to bench/);
    await view.cleanup();
  }

  {
    const view = await mount(
      createElement(RunDetail, {
        run: run(),
        agents: feed<AgentRow>(),
        events: feed<EventRow>(),
        stages: feed<EventRow>(),
        stagesPath: "/api/live/stages",
        audit: undefined,
        evidence: undefined,
        job: job("gone"),
        machine: undefined,
        target: { id: "gone", machine: undefined },
        harnesses: [],
        jobSpend: undefined,
        closeHref: "/",
        fullView: { full: false, toggleHref: "/?full=1" },
      }),
    );
    assert.equal(view.failed, "", view.failed);
    assert.match(view.text, /Waiting on gone/);
    await view.cleanup();
  }

  {
    const view = await mount(createElement(UnstableClock));
    assert.match(view.failed, /Maximum update depth|getSnapshot should be cached/, "Date.now() as a snapshot still loops");
    await view.cleanup();
  }
} finally {
  Date.now = realNow;
  await dom.happyDOM.close();
}

console.log("panel clock regressions passed");
