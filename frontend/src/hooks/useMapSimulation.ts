// TEMP-SIM: temporary demo flight for the map pages (see lib/mapSimulation.ts).
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildSimulationRoute } from "@/lib/mapSimulation";
import type { RoutePoint } from "@/lib/route";

const REVEAL_INTERVAL_MS = 600;

export function useMapSimulation(gs: { lat: number; lng: number; alt: number }) {
  const [active, setActive] = useState(false);
  const [revealed, setRevealed] = useState(0);
  const full = useMemo(() => buildSimulationRoute(gs), [gs.lat, gs.lng, gs.alt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return;
    setRevealed(1);
    const id = window.setInterval(() => {
      setRevealed((n) => Math.min(full.length, n + 1));
    }, REVEAL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [active, full]);

  const start = useCallback(() => setActive(true), []);
  const stop = useCallback(() => { setActive(false); setRevealed(0); }, []);

  const route: RoutePoint[] | null = useMemo(
    () => (active ? full.slice(0, revealed) : null),
    [active, full, revealed],
  );
  return { active, start, stop, route, full, total: full.length };
}
