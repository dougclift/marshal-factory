"use client";

import type { ReactNode } from "react";
import type { AgentRow, MachineRow, RunRow } from "@/db/schema";
import { cn } from "@/lib/utils";
import { STAGES } from "@/lib/events";
import { t3ThreadLink } from "@/lib/machine";
import { t3EnvironmentId, targetNote, type BoardCard } from "./cards";
import { StageCard } from "./run-card";
import { STAGE_META } from "./stages";
import { useNow } from "./time";

/** Heartbeats go stale over minutes, so the pin note does not need a finer clock. */
const CLOCK_TICK_MS = 30_000;

/** A local thread whose stop couldn't be confirmed opens in its machine's T3; a sandbox's has no direct link. */
function stopT3Href(card: BoardCard, machines: ReadonlyMap<string, MachineRow>) {
  if (card.stop?.view.kind !== "unconfirmed" || !card.stop.thread || card.runsOn?.kind !== "local") return undefined;
  return t3ThreadLink(card.stop.thread, t3EnvironmentId(machines.get(card.runsOn.machineId)));
}

export function Board({
  cards,
  agentsBySession,
  selected,
  machines,
  repoLabels,
  incoming,
}: {
  cards: readonly BoardCard[];
  agentsBySession: Map<string, AgentRow[]>;
  selected: string | undefined;
  machines: ReadonlyMap<string, MachineRow>;
  /** Each repo's short name, while more than one repo has jobs; undefined shows no repo. */
  repoLabels?: ReadonlyMap<string, string>;
  /** The Incoming column, ahead of Queued. */
  incoming?: ReactNode;
}) {
  const now = useNow(CLOCK_TICK_MS) ?? 0;
  const agentsOf = (runs: readonly RunRow[]) =>
    runs.flatMap((r) => agentsBySession.get(r.session_id) ?? []);
  const targetOf = (card: BoardCard) => (card.targetMachineId ? targetNote(machines.get(card.targetMachineId), card.targetMachineId, now) : null);
  const columns = STAGES.filter(
    (stage) => stage !== "failed" || cards.some((c) => c.stage === "failed"),
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 divide-x overflow-x-auto overflow-y-hidden">
      {incoming}
      {columns.map((stage) => {
        const items = cards.filter((c) => c.stage === stage);
        return (
          <section
            key={stage}
            data-stage={stage}
            aria-label={STAGE_META[stage].label}
            className="flex h-full w-80 shrink-0 flex-col last:border-e"
          >
            <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/72 px-3 font-medium">
              <span className={cn("size-2 rounded-full", STAGE_META[stage].dot)} />
              {STAGE_META[stage].label}
              <span className="text-xs text-muted-foreground tabular-nums">{items.length}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-y-contain p-2">
              {items.length === 0 && <p className="px-1 text-xs text-faint">None</p>}
              {items.map((card) => (
                <StageCard
                  key={card.id}
                  card={card}
                  machineName={card.machineId && (machines.get(card.machineId)?.name ?? card.machineId)}
                  target={targetOf(card)}
                  agents={agentsOf(card.runs)}
                  selected={card.runs.some((r) => r.session_id === selected)}
                  repoLabel={card.repo ? repoLabels?.get(card.repo) : undefined}
                  t3Href={stopT3Href(card, machines)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
