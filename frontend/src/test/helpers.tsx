import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { LiveDataProvider } from "@/hooks/useLiveData";

/** A controllable stand-in for the browser WebSocket the live-data provider opens. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  static reset() {
    FakeWebSocket.instances = [];
  }

  static get latest(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  send() {
    /* the UI never sends over the socket */
  }

  /** Test helpers: what the backend would do. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

export function packet(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: 12_000,
    packetCount: 1,
    latitude: 67.9,
    longitude: 21.1,
    altitude: 1200,
    gpsFix: true,
    gpsSats: 12,
    rssi: -70,
    snr: 30,
    freqDevHz: 100,
    successRate: 100,
    noiseFloor: -100,
    txMcs: 0,
    systemState: 2,
    systemStateLabel: "FLIGHT",
    halowCurrMa: 180,
    chipTempC: 30,
    heaterPower: 0,
    pressurePa: 90_000,
    extTempC: 5,
    intTempC: 15,
    extHumidityRh: 40,
    radiationCps: 2,
    errorFlags: 0,
    halowStatus: "ACTIVE",
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <LiveDataProvider>{children}</LiveDataProvider>
    </MemoryRouter>
  );
}
