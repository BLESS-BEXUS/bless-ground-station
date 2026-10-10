import { useCallback, useEffect, useState } from "react";
import { loadMissionT0, saveMissionT0 } from "@/lib/missionClock";

/**
 * Operator-driven mission clock. It runs on the ground-station computer's
 * clock and does not depend on any packet having arrived: `start(offset)`
 * anchors T=0 so that "now" reads `offset` (negative before liftoff).
 */
export function useMissionClock() {
  const [t0, setT0] = useState<number | null>(loadMissionT0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (t0 === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [t0]);

  const start = useCallback((offsetSeconds: number) => {
    const anchor = Date.now() - offsetSeconds * 1000;
    saveMissionT0(anchor);
    setT0(anchor);
    setNow(Date.now());
  }, []);

  /** Move the displayed time by `deltaSeconds` (positive = clock jumps ahead). */
  const adjust = useCallback(
    (deltaSeconds: number) => {
      if (t0 === null) return;
      const anchor = t0 - deltaSeconds * 1000;
      saveMissionT0(anchor);
      setT0(anchor);
    },
    [t0],
  );

  const stop = useCallback(() => {
    saveMissionT0(null);
    setT0(null);
  }, []);

  return {
    running: t0 !== null,
    offsetMs: t0 === null ? null : now - t0,
    start,
    adjust,
    stop,
  };
}
