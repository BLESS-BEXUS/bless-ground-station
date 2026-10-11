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
});
