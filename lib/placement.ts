import type { Execution } from "./execution";

/** A runner, as the machines table names it. */
export type NamedMachine = { id: string; name: string };

/**
 * Where a job should run before a runner's own fallbacks. A pin is local on that machine,
 * ahead of a Runs on label and of Settings.
 */
export type Placement = { execution: Execution; targetMachine: string | null };

export function placementOf(
  ticket: { execution?: Execution | null; targetMachine?: string | null },
  /** A pin stored on the source row, such as queue_items.target_machine. It wins over a label. */
  columnTarget: string | null | undefined,
  fallback: Execution,
): Placement {
  const targetMachine = columnTarget || ticket.targetMachine || null;
  return { execution: targetMachine ? "local" : (ticket.execution ?? fallback), targetMachine };
}

/** Whether this runner may claim a job that would run at `placement`. */
export function machineMayClaim(placement: Placement, machineId: string, executions: readonly Execution[]): boolean {
  if (!executions.includes(placement.execution)) return false;
  if (placement.targetMachine !== null && placement.targetMachine !== machineId) return false;
  return true;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** An id matches before a display name. Two machines with the same name are not a match. */
export function matchMachine(machines: readonly NamedMachine[], query: string): { machine: NamedMachine } | { error: string } {
  const name = query.trim();
  const byId = machines.filter((machine) => machine.id === name || same(machine.id, name));
  if (byId.length === 1) return { machine: byId[0]! };
  const byName = machines.filter((machine) => same(machine.name, name));
  if (byId.length === 0 && byName.length === 1) return { machine: byName[0]! };
  if (byId.length + byName.length > 1) return { error: `More than one machine is named ${name}.` };
  return { error: `No machine is named ${name}.` };
}
