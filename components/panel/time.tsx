"use client";

import { useState, useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/**
 * Runs `read` only in the browser, so server HTML never bakes in the server's clock or timezone.
 *
 * `read` is the getSnapshot passed to useSyncExternalStore. It must return the same value on every
 * call until something notifies React. A read that moves on its own, such as `Date.now`, makes a
 * client mount (not a hydration) loop and throw: React's "getSnapshot should be cached", error #185.
 * A clock belongs in `useNow`.
 */
export function useAfterHydration<T extends string | number>(
  /** Stable between calls. Do not read the clock here. */
  read: () => T,
  fallback: T,
): T {
  return useSyncExternalStore(noSubscription, read, () => fallback);
}

export function Time({ date }: { date: Date }) {
  const text = useAfterHydration(
    () => date.toLocaleTimeString("en-GB", { hour12: false }),
    "",
  );
  return <time dateTime={date.toISOString()}>{text}</time>;
}

/** A dense timestamp: the time for today, the day and month before that. */
export function ShortTime({ date }: { date: Date }) {
  const text = useAfterHydration(() => {
    const today = new Date().toDateString() === date.toDateString();
    return today
      ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
      : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }, "");
  return <time dateTime={date.toISOString()}>{text}</time>;
}

export function useNow(intervalMs: number): number | null {
  const [store] = useState(() => createClock(intervalMs));
  return useSyncExternalStore(store.subscribe, store.read, () => null);
}

function createClock(intervalMs: number) {
  let now = Date.now();
  return {
    // Must return the same value until the next tick, or React re-renders in a loop.
    read: () => now,
    subscribe(notify: () => void) {
      now = Date.now();
      const id = setInterval(() => {
        now = Date.now();
        notify();
      }, intervalMs);
      return () => clearInterval(id);
    },
  };
}
