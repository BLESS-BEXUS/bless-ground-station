import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveData } from "@/hooks/useLiveData";
import { FakeWebSocket, packet, Providers } from "./helpers";

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

function mount() {
  const hook = renderHook(() => useLiveData(), { wrapper: Providers });
  const socket = () => FakeWebSocket.latest;
  return { ...hook, socket };
}

describe("live data provider", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    window.localStorage.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts with every value empty and no link", () => {
    const { result } = mount();
    const t = result.current.telemetry;
    expect(t.latitude).toBeNull();
    expect(t.rssi).toBeNull();
    expect(t.packetCount).toBeNull();
    expect(t.halowStatus).toBeNull();
    expect(result.current.connection.mode).toBe("none");
    expect(result.current.logging).toBe(false);
    expect(result.current.route).toEqual([]);
  });

  it("derives the link mode from the packets that arrive, never from the serial port", async () => {
    const { result, socket } = mount();
    act(() => socket().open());
    expect(result.current.connection.wsConnected).toBe(true);

    // a connected serial port alone does not mean data is flowing
    act(() => socket().receive({ type: "connection", serial: true, port: "COM7" }));
    await flush(1000);
    expect(result.current.connection.serialConnected).toBe(true);
    expect(result.current.connection.mode).toBe("none");

    act(() => socket().receive({ type: "elink_telemetry", data: packet({ packetCount: 1 }) }));
    await flush(1000);
    expect(result.current.connection.mode).toBe("elink");
    expect(result.current.telemetry.packetCount).toBe(1);

    act(() => socket().receive({ type: "telemetry", data: packet({ packetCount: 2 }) }));
    await flush(1000);
    expect(result.current.connection.mode).toBe("halow+elink");
  });

  it("falls back as each link goes quiet: HALOW+E-LINK, then the one that is left, then none", async () => {
    const { result, socket } = mount();
    act(() => socket().open());
    act(() => socket().receive({ type: "elink_telemetry", data: packet() }));
    act(() => socket().receive({ type: "telemetry", data: packet() }));
    await flush(1000);
    expect(result.current.connection.mode).toBe("halow+elink");

    // HaLow keeps arriving every 10 s, E-Link stops
    for (let i = 0; i < 4; i++) {
      await flush(10_000);
      act(() => socket().receive({ type: "telemetry", data: packet({ packetCount: 10 + i }) }));
    }
    expect(result.current.connection.mode).toBe("halow");

    // then HaLow stops as well
    await flush(31_000);
    expect(result.current.connection.mode).toBe("none");
  });

  it("does not flap between modes while packets keep their normal period", async () => {
    const { result, socket } = mount();
    act(() => socket().open());
    const seen = new Set<string>();
    for (let second = 1; second <= 60; second++) {
      if (second % 5 === 0) act(() => socket().receive({ type: "elink_telemetry", data: packet({ packetCount: second }) }));
      if (second % 10 === 0) act(() => socket().receive({ type: "telemetry", data: packet({ packetCount: second }) }));
      await flush(1000);
      if (second > 12) seen.add(result.current.connection.mode);
    }
    expect([...seen]).toEqual(["halow+elink"]);
  });

  it("marks the link INTERRUPTED once nothing fresh arrives, and keeps the last values", async () => {
    const { result, socket } = mount();
    act(() => socket().open());
    act(() => socket().receive({ type: "elink_telemetry", data: packet({ rssi: -66, halowStatus: "ACTIVE" }) }));
    await flush(1000);
    expect(result.current.telemetry.halowStatus).toBe("ACTIVE");
    await flush(8000);
    expect(result.current.telemetry.halowStatus).toBe("INTERRUPTED");
    expect(result.current.telemetry.rssi).toBe(-66);
  });

  it("keeps each link's own telemetry: E-Link packets never refresh the HaLow data", async () => {
    const { result, socket } = mount();
    act(() => socket().open());
    act(() => socket().receive({ type: "elink_telemetry", data: packet({ packetCount: 7, altitude: 500 }) }));
    await flush(1000);
    expect(result.current.elinkTelemetry.packetCount).toBe(7);
    expect(result.current.halowTelemetry.packetCount).toBeNull();
    expect(result.current.connection.halowFresh).toBe(false);
    expect(result.current.connection.elinkFresh).toBe(true);

    act(() => socket().receive({ type: "telemetry", data: packet({ packetCount: 3, altitude: 480 }) }));
    await flush(1000);
    expect(result.current.halowTelemetry.packetCount).toBe(3);
    expect(result.current.connection.halowFresh).toBe(true);
  });

  it("marks only the quiet link INTERRUPTED and keeps its last values", async () => {
    const { result, socket } = mount();
    act(() => socket().open());
    act(() => socket().receive({ type: "telemetry", data: packet({ packetCount: 1, halowStatus: "ACTIVE", rssi: -60 }) }));
    act(() => socket().receive({ type: "elink_telemetry", data: packet({ packetCount: 1, halowStatus: "ACTIVE" }) }));
    await flush(1000);
    expect(result.current.halowTelemetry.halowStatus).toBe("ACTIVE");

    // E-Link keeps arriving every 5 s, HaLow stops
    for (let i = 0; i < 7; i++) {
      await flush(5000);
      act(() => socket().receive({ type: "elink_telemetry", data: packet({ packetCount: 2 + i, halowStatus: "ACTIVE" }) }));
    }
    expect(result.current.connection.halowFresh).toBe(false);
    expect(result.current.halowTelemetry.halowStatus).toBe("INTERRUPTED");
    expect(result.current.halowTelemetry.packetCount).toBe(1);
    expect(result.current.elinkTelemetry.halowStatus).toBe("ACTIVE");
    expect(result.current.connection.mode).toBe("elink");
  });

  it("keeps the recorded route in step with the backend", async () => {
    const { result, socket } = mount();
    act(() => socket().open());

    const first = { lat: 67.9, lng: 21.1, alt: 1000, t: 1, link: "halow", pkt: 1, rssi: -70 };
    const legacy = { lat: 67.91, lng: 21.11, alt: 1100, t: 2, link: "elink", pkt: 2 };   // no rssi field
    act(() => socket().receive({ type: "route", points: [first, legacy] }));
    expect(result.current.route).toHaveLength(2);
    expect(result.current.route[1].rssi).toBeNull();

    act(() => socket().receive({
      type: "route_point",
      point: { lat: 67.92, lng: 21.12, alt: 1200, t: 3, link: "elink", pkt: 3, rssi: -75 },
    }));
    expect(result.current.route).toHaveLength(3);
    expect(result.current.route[2].rssi).toBe(-75);

    act(() => socket().receive({ type: "route", points: [] }));
    expect(result.current.route).toEqual([]);
  });

  it("never lets the route grow without bound", () => {
    const { result, socket } = mount();
    act(() => socket().open());
    const many = Array.from({ length: 20_500 }, (_, i) => ({
      lat: 67 + i / 1e6, lng: 21, alt: 0, t: i, link: "elink", pkt: i, rssi: -70,
    }));
    act(() => socket().receive({ type: "route", points: many }));
    expect(result.current.route).toHaveLength(20_000);
    expect(result.current.route[19_999].pkt).toBe(20_499);   // the newest are kept
  });

  it("follows the REC state sent by the backend and toggles it through the right endpoint", async () => {
    const { result, socket } = mount();
    act(() => socket().open());
    act(() => socket().receive({ type: "logging", active: true }));
    expect(result.current.logging).toBe(true);

    await act(async () => { await result.current.toggleLogging(); });
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("/logging/stop"), { method: "POST" });

    act(() => socket().receive({ type: "logging", active: false }));
    await act(async () => { await result.current.toggleLogging(); });
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("/logging/start"), { method: "POST" });
  });

  it("sends commands with their parameters and reports a network failure instead of throwing", async () => {
    const { result } = mount();
    await act(async () => { await result.current.sendCommand("SET_TX_POWER", [12]); });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toContain("/cmd/SET_TX_POWER");
    expect(JSON.parse(init.body)).toEqual({ params: [12] });

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    let outcome: { ok: boolean } | undefined;
    await act(async () => { outcome = await result.current.sendCommand("PING"); });
    expect(outcome?.ok).toBe(false);
  });

  it("reconnects the WebSocket by itself after it drops", async () => {
    const { socket } = mount();
    act(() => socket().open());
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => socket().close());
    await flush(3100);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("ignores malformed frames without breaking", () => {
    const { result, socket } = mount();
    act(() => socket().open());
    act(() => socket().onmessage?.({ data: "{not json" }));
    act(() => socket().receive({ type: "elink_telemetry" }));            // no data
    act(() => socket().receive({ type: "route", points: "nope" }));
    expect(result.current.route).toEqual([]);
    expect(result.current.telemetry.packetCount).toBeNull();
  });

  it("keeps the payload's RSSI and the ground station's RSSI in separate fields and histories", () => {
    const { result, socket } = mount();
    act(() => socket().open());

    // the payload sends zeros; the ground module has a reading: the payload fields stay empty
    act(() => socket().receive({
      type: "elink_telemetry",
      data: packet({ packetCount: 1, rssi: 0, snr: 0, noiseFloor: 0, freqDevHz: 0, gsRssi: -81, gsSnr: 20, gsNoiseFloor: -101 }),
    }));
    expect(result.current.elinkTelemetry.rssi).toBeNull();
    expect(result.current.elinkTelemetry.gsRssi).toBe(-81);
    expect(result.current.elinkTelemetry.rssiHistory).toEqual([]);
    expect(result.current.elinkTelemetry.gsRssiHistory.map((p) => p.rssi)).toEqual([-81]);

    // both measure: each history gets its own value
    act(() => socket().receive({
      type: "elink_telemetry",
      data: packet({ packetCount: 2, timestamp: 17_000, rssi: -40, snr: 38, gsRssi: -54, gsSnr: 30 }),
    }));
    expect(result.current.elinkTelemetry.rssiHistory.map((p) => p.rssi)).toEqual([-40]);
    expect(result.current.elinkTelemetry.gsRssiHistory.map((p) => p.rssi)).toEqual([-81, -54]);

    // and the HaLow link keeps its own pair too
    act(() => socket().receive({
      type: "telemetry",
      data: packet({ packetCount: 3, rssi: -45, gsRssi: -58 }),
    }));
    expect(result.current.halowTelemetry.rssi).toBe(-45);
    expect(result.current.halowTelemetry.gsRssi).toBe(-58);
  });

  it("remembers the ground-station coordinates and adopts changes made in another tab", () => {
    const { result } = mount();
    expect(result.current.groundStation.lat).toBeCloseTo(67.8856, 4);

    act(() => result.current.setGroundStation({ ...result.current.groundStation, lat: 67.8890432, alt: 474 }));
    expect(JSON.parse(window.localStorage.getItem("bless-ground-station")!)).toMatchObject({ lat: 67.8890432, alt: 474 });

    // another tab saves a new value and the browser announces it
    window.localStorage.setItem("bless-ground-station", JSON.stringify({ lat: 68, lng: 22, alt: 500, name: "Other" }));
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "bless-ground-station" })); });
    expect(result.current.groundStation.lat).toBe(68);
    expect(result.current.groundStation.name).toBe("Other");
  });

  describe("reporting the ground station to the backend", () => {
    const reports = () => fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/gs/position"))
      .map(([, init]) => JSON.parse(init.body));

    it("sends the campaign default, marked as default, when the operator has set nothing", async () => {
      const { socket } = mount();
      expect(reports()).toHaveLength(0);          // nothing before the backend connection is up
      act(() => socket().open());
      await flush();
      expect(reports()).toHaveLength(1);
      expect(reports()[0]).toMatchObject({ source: "default", name: "Esrange Space Center" });
    });

    it("sends the operator's coordinates as soon as they are saved", async () => {
      const { result, socket } = mount();
      act(() => socket().open());
      await flush();
      act(() => result.current.setGroundStation({ lat: 67.87964, lng: 21.062234, alt: 484, name: "Radar Hill" }));
      await flush();
      expect(reports().at(-1)).toEqual({ lat: 67.87964, lng: 21.062234, alt: 484, name: "Radar Hill", source: "operator" });
    });

    it("sends the saved coordinates again after the WebSocket reconnects", async () => {
      window.localStorage.setItem("bless-ground-station",
        JSON.stringify({ lat: 67.87964, lng: 21.062234, alt: 484, name: "Radar Hill" }));
      const { socket } = mount();
      act(() => socket().open());
      await flush();
      expect(reports()).toHaveLength(1);
      expect(reports()[0]).toMatchObject({ source: "operator", alt: 484 });

      act(() => socket().close());
      await flush(3100);
      act(() => socket().open());
      await flush();
      expect(reports()).toHaveLength(2);
    });

    it("keeps working when the backend cannot be reached", async () => {
      fetchMock.mockRejectedValue(new Error("offline"));
      const { result, socket } = mount();
      act(() => socket().open());
      await flush();
      expect(result.current.connection.wsConnected).toBe(true);
    });
  });
});
