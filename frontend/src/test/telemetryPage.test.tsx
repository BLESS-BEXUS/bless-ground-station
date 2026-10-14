import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, packet, Providers } from "./helpers";
import TelemetryChartsPage from "@/pages/TelemetryChartsPage";
import CommandModal from "@/components/CommandModal";

// Recharts needs real layout; the page tests only care about what is asked of it.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const React = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "chart" }, children),
  };
});

const fetchMock = vi.fn();

beforeEach(() => {
  FakeWebSocket.reset();
  window.localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function connect() {
  const ws = FakeWebSocket.latest;
  act(() => ws.open());
  return ws;
}

describe("Telemetría page", () => {
  it("shows an empty state until E-Link packets arrive", () => {
    render(<Providers><TelemetryChartsPage /></Providers>);
    connect();
    expect(screen.getByText("No E-Link packets yet")).toBeTruthy();
    expect(screen.getAllByText("Waiting for data").length).toBeGreaterThan(0);
  });

  it("plots E-Link packets and counts them", () => {
    render(<Providers><TelemetryChartsPage /></Providers>);
    const ws = connect();
    act(() => {
      for (let i = 0; i < 3; i++) {
        ws.receive({
          type: "elink_telemetry",
          data: packet({ packetCount: i, altitude: 100 + i * 10, receivedAt: new Date(Date.now() - (3 - i) * 1000).toISOString() }),
        });
      }
    });
    expect(screen.getByText(/3 packets in view/)).toBeTruthy();
    expect(screen.getAllByTestId("chart").length).toBeGreaterThan(10);
  });

  it("falls back to the ground module's figures when the payload reports 0", () => {
    render(<Providers><TelemetryChartsPage /></Providers>);
    const ws = connect();
    act(() => {
      ws.receive({
        type: "elink_telemetry",
        data: packet({ rssi: 0, snr: 0, noiseFloor: 0, freqDevHz: 0, gsRssi: -81, gsSnr: 20, gsNoiseFloor: -101 }),
      });
    });
    expect(screen.getAllByText("ground module").length).toBeGreaterThan(0);
    expect(screen.getByText("-81.0")).toBeTruthy();
  });

  it("restores the history sent when the page reconnects", () => {
    render(<Providers><TelemetryChartsPage /></Providers>);
    const ws = connect();
    act(() => {
      ws.receive({
        type: "history",
        elink: [packet({ packetCount: 1 }), packet({ packetCount: 2 })],
        gsRf: [],
      });
    });
    expect(screen.getByText(/2 packets in view/)).toBeTruthy();
  });

  it("changes the time window", () => {
    render(<Providers><TelemetryChartsPage /></Providers>);
    connect();
    const all = screen.getByRole("button", { name: "All" });
    fireEvent.click(all);
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "30 min" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("HaLow mode command", () => {
  it("sends SET_HALOW_MODE with 0 for AP and 1 for GROUP", async () => {
    render(<Providers><CommandModal open onClose={() => {}} /></Providers>);
    const ws = connect();
    act(() => ws.receive({ type: "elink_connection", connected: true, ready: true }));

    fireEvent.click(screen.getByRole("button", { name: "HaLow MODE" }));
    fireEvent.click(screen.getByRole("button", { name: "AP" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Enviar/ })); });

    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(url).toContain("/cmd/SET_HALOW_MODE");
    expect(JSON.parse(init.body)).toEqual({ params: [0] });
  });
});
