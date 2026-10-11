import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, packet, Providers } from "./helpers";

// Leaflet needs real layout; these stand-ins expose what the page asks it to draw.
vi.mock("react-leaflet", async () => {
  const React = await import("react");
  type WithChildren = { children?: React.ReactNode };
  const box = (testId: string) => ({ children }: WithChildren) =>
    React.createElement("div", { "data-testid": testId }, children);
  return {
    MapContainer: box("map"),
    TileLayer: ({ url }: { url: string }) =>
      React.createElement("div", { "data-testid": "tile-layer", "data-url": url }),
    Marker: box("marker"),
    Popup: box("popup"),
    Tooltip: box("tooltip"),
    Polyline: ({ positions, pathOptions, children }: WithChildren & {
      positions?: unknown[];
      pathOptions?: { color?: string; weight?: number };
    }) =>
      React.createElement(
        "div",
        {
          "data-testid": "polyline",
          "data-color": pathOptions?.color,
          "data-weight": pathOptions?.weight,
          "data-points": positions?.length,
        },
        children,
      ),
    useMap: () => ({
      setView() {}, panTo() {}, fitBounds() {}, invalidateSize() {},
      getContainer: () => document.createElement("div"),
    }),
  };
});

import AntennaPage from "@/pages/AntennaPage";
import GroundRadioPage from "@/pages/GroundRadioPage";
import MapPage from "@/pages/MapPage";
import TopNav from "@/components/TopNav";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  FakeWebSocket.reset();
  window.localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hhmmss = () => screen.getByTitle(/Mission clock/).textContent ?? "";

describe("mission clock in the top bar", () => {
  it("shows no time until the operator starts it, whatever packets arrive", async () => {
    vi.useFakeTimers();
    render(<Providers><TopNav /></Providers>);
    expect(hhmmss()).toContain("--:--:--");

    act(() => FakeWebSocket.latest.open());
    act(() => FakeWebSocket.latest.receive({ type: "elink_telemetry", data: packet({ timestamp: 99_000 }) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(hhmmss()).toContain("--:--:--");
  });

  it("counts down from the chosen T-, crosses T+0, and survives a page reload", async () => {
    vi.useFakeTimers();
    const first = render(<Providers><TopNav /></Providers>);

    fireEvent.click(screen.getByTitle(/Mission clock not started/));
    fireEvent.change(screen.getByPlaceholderText("HH:MM:SS"), { target: { value: "00:00:05" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(hhmmss()).toContain("00:00:05");
    expect(hhmmss()).toContain("T-");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(hhmmss()).toContain("00:00:02");

    // a refresh keeps the same mission time (the anchor is stored in the browser)
    first.unmount();
    render(<Providers><TopNav /></Providers>);
    expect(hhmmss()).toContain("T-");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(hhmmss()).toContain("T+");
    expect(hhmmss()).toContain("00:00:01");
  });

  it("rejects a malformed time instead of starting", () => {
    render(<Providers><TopNav /></Providers>);
    fireEvent.click(screen.getByTitle(/Mission clock not started/));
    fireEvent.change(screen.getByPlaceholderText("HH:MM:SS"), { target: { value: "4 hours" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByText(/Use HH:MM:SS/)).toBeInTheDocument();
    expect(window.localStorage.getItem("bless.missionClock.t0")).toBeNull();
  });

  it("can be nudged for fine sync and stopped", () => {
    render(<Providers><TopNav /></Providers>);
    fireEvent.click(screen.getByTitle(/Mission clock not started/));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));               // default T-04:00:00
    expect(hhmmss()).toContain("04:00:00");

    fireEvent.click(screen.getByTitle(/Mission clock — click to adjust/));
    fireEvent.click(screen.getByRole("button", { name: "+10 s" }));
    fireEvent.click(screen.getByRole("button", { name: "+10 s" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop / reset" }));
    expect(hhmmss()).toContain("--:--:--");
    expect(window.localStorage.getItem("bless.missionClock.t0")).toBeNull();
  });
});

describe("antenna page coordinates", () => {
  const inputs = () => screen.getAllByRole("spinbutton") as HTMLInputElement[];

  it("keeps what was typed after leaving the page and coming back", () => {
    const first = render(<Providers><AntennaPage /></Providers>);
    fireEvent.change(inputs()[0], { target: { value: "67.8890432" } });
    fireEvent.change(inputs()[1], { target: { value: "21.0836784" } });
    fireEvent.change(inputs()[2], { target: { value: "474" } });
    first.unmount();

    render(<Providers><AntennaPage /></Providers>);
    expect(inputs().map((i) => i.value)).toEqual(["67.8890432", "21.0836784", "474"]);
  });

  it("does not overwrite the saved value with 0 while a field is being retyped", () => {
    render(<Providers><AntennaPage /></Providers>);
    fireEvent.change(inputs()[0], { target: { value: "67.9" } });
    fireEvent.change(inputs()[0], { target: { value: "" } });
    expect(JSON.parse(window.localStorage.getItem("bless-ground-station")!).lat).toBe(67.9);
  });

  it("shows empty values, not zeros, until a position arrives", () => {
    render(<Providers><AntennaPage /></Providers>);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("allows a negative elevation when the payload is below the station", () => {
    render(<Providers><AntennaPage /></Providers>);
    act(() => FakeWebSocket.latest.open());
    act(() => FakeWebSocket.latest.receive({
      type: "elink_telemetry",
      // ~1.3 km north of the default station, 200 m below it
      data: packet({ latitude: 67.8856 + 0.0117, longitude: 21.0786, altitude: 110 }),
    }));
    expect(screen.getByText(/^-\d+\.\d°$/)).toBeInTheDocument();
  });
});

describe("ground HaLow configuration tab", () => {
  const status = (over: Record<string, unknown> = {}) => ({
    connected: true, disabled: false, port: "COM7", commands: [], applied: {}, history: [], ...over,
  });

  function route(handler: (url: string, init?: RequestInit) => unknown) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => jsonResponse(handler(url, init)));
  }

  it("explains why it cannot be used when the module is missing", async () => {
    route(() => status({ connected: false, disabled: true, port: "none" }));
    render(<Providers><GroundRadioPage /></Providers>);
    expect(await screen.findByText(/no HaLow module/)).toBeInTheDocument();
    screen.getAllByRole("button", { name: "Apply" }).forEach((b) => expect(b).toBeDisabled());
  });

  it("sends TX power to the ground module and shows the answer", async () => {
    const posted: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    route((url, init) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { ok: true, name: "TXPOWER", value: "14", attempts: 1, response: ["OK"], sentAt: "", finishedAt: "" };
      }
      return status();
    });
    render(<Providers><GroundRadioPage /></Providers>);
    await screen.findByText(/port COM7/);

    const power = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(power, { target: { value: "14" } });
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[0]); });

    expect(posted).toEqual([{ name: "TXPOWER", value: "14" }]);
    expect(await screen.findByText(/Applied/)).toBeInTheDocument();
  });

  it("will not send an out-of-range TX power or an empty field", async () => {
    route(() => status());
    render(<Providers><GroundRadioPage /></Providers>);
    await screen.findByText(/port COM7/);
    const power = screen.getAllByRole("spinbutton")[0];
    const apply = screen.getAllByRole("button", { name: "Apply" })[0];

    fireEvent.change(power, { target: { value: "30" } });
    expect(apply).toBeDisabled();
    fireEvent.change(power, { target: { value: "" } });
    expect(apply).toBeDisabled();
    fireEvent.change(power, { target: { value: "12" } });
    expect(apply).toBeEnabled();
  });

  it("asks before changing something that breaks the link, and sends nothing if declined", async () => {
    const posted: unknown[] = [];
    route((url, init) => {
      if (init?.method === "POST") { posted.push(init.body); return { ok: true }; }
      return status();
    });
    render(<Providers><GroundRadioPage /></Providers>);
    await screen.findByText(/port COM7/);

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const rows = screen.getAllByRole("button", { name: "Apply" });
    await act(async () => { fireEvent.click(rows[2]); });            // bandwidth
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(0);

    confirm.mockReturnValue(true);
    await act(async () => { fireEvent.click(rows[2]); });
    expect(posted).toHaveLength(1);
  });

  it("builds the frequency range in 100 kHz units", async () => {
    const posted: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    route((url, init) => {
      if (init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return { ok: true, attempts: 1 }; }
      return status();
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Providers><GroundRadioPage /></Providers>);
    await screen.findByText(/port COM7/);

    const [, start, end] = screen.getAllByRole("spinbutton");
    fireEvent.change(start, { target: { value: "866.5" } });
    fireEvent.change(end, { target: { value: "867.5" } });
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[3]); });
    expect(posted).toEqual([{ name: "FREQ_RANGE", value: "8665,8675" }]);
  });

  it("shows a failed command with the module's own words", async () => {
    route((url, init) => (init?.method === "POST"
      ? { ok: false, name: "TXPOWER", value: "12", attempts: 3, response: [], error: "No OK from the module after 3 attempts", sentAt: "", finishedAt: "" }
      : status()));
    render(<Providers><GroundRadioPage /></Providers>);
    await screen.findByText(/port COM7/);
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[0]); });
    expect(await screen.findByText(/No OK from the module after 3 attempts/)).toBeInTheDocument();
  });
});

describe("map page", () => {
  const route = (links: Array<"halow" | "elink">, rssi: number[]) =>
    links.map((link, i) => ({ lat: 67.9 + i * 0.01, lng: 21.1 + i * 0.01, alt: 1000 + i * 10, t: i, link, pkt: i, rssi: rssi[i] }));

  function renderMap(points: ReturnType<typeof route> = []) {
    render(<Providers><MapPage /></Providers>);
    act(() => FakeWebSocket.latest.open());
    if (points.length) act(() => FakeWebSocket.latest.receive({ type: "route", points }));
  }

  const lines = () => screen.queryAllByTestId("polyline");
  const colors = () => lines().map((l) => l.getAttribute("data-color"));

  it("keeps Leaflet's layers inside their own stacking context, below the top-bar dialogs", () => {
    renderMap();
    // Leaflet panes use z-index 400-1000; without isolation they paint over a z-50 dialog
    expect(screen.getByTestId("map").parentElement?.className).toMatch(/isolate/);
  });

  it("loads its tiles from the backend cache", () => {
    renderMap();
    expect(screen.getByTestId("tile-layer").getAttribute("data-url")).toMatch(/:8765\/tiles\/\{z\}\/\{x\}\/\{y\}\.png$/);
  });

  it("starts on the standard map and draws the route blue while HaLow is received, yellow after", () => {
    renderMap(route(["halow", "halow", "halow", "elink", "elink"], [-60, -65, -70, -80, -85]));
    expect(screen.getByRole("button", { name: "Standard" }).className).toMatch(/primary/);
    expect(screen.getByText("HaLow GNSS", { selector: "div" })).toBeInTheDocument();
    expect(colors()).toContain("#1E88FF");
    expect(colors()).toContain("#FFC400");
    expect(screen.queryByText("RSSI (dBm)")).not.toBeInTheDocument();
  });

  it("does not draw dots, only lines", () => {
    renderMap(route(["halow", "elink"], [-60, -80]));
    expect(screen.queryAllByTestId("circle-marker")).toHaveLength(0);
    expect(lines().length).toBeGreaterThan(0);
  });

  it("switches to the RSSI map: a gradient line, no blue or yellow, legend and statistics", () => {
    renderMap(route(["halow", "halow", "elink", "elink"], [-40, -60, -80, -100]));
    fireEvent.click(screen.getByRole("button", { name: "RSSI heat map" }));

    expect(colors()).not.toContain("#1E88FF");
    expect(colors()).not.toContain("#FFC400");
    const gradient = colors().filter((c) => c?.startsWith("rgb("));
    expect(new Set(gradient).size).toBeGreaterThan(3);     // really fades, not one color

    expect(screen.getByText("RSSI (dBm)")).toBeInTheDocument();
    expect(screen.getByText(/MM6108 sensitivity/)).toBeInTheDocument();
    expect(screen.getByText("RSSI min").nextSibling?.textContent).toMatch(/-100/);
    expect(screen.getByText("RSSI max").nextSibling?.textContent).toMatch(/-40/);

    fireEvent.click(screen.getByRole("button", { name: "Standard" }));
    expect(colors()).toContain("#1E88FF");
  });

  it("draws a leg with no valid RSSI in grey and says so", () => {
    renderMap(route(["halow", "halow", "halow"], [-60, null as unknown as number, -80]));
    fireEvent.click(screen.getByRole("button", { name: "RSSI heat map" }));
    expect(colors()).toContain("#9AA5B1");
    expect(screen.getByText(/Grey line = no valid reading/)).toBeInTheDocument();
  });

  it("runs the temporary demo flight with 15 E-Link and 7 HaLow packets", () => {
    vi.useFakeTimers();
    renderMap();
    fireEvent.click(screen.getByRole("button", { name: /Simulate 15 E-Link \+ 7 HaLow/ }));
    act(() => { vi.advanceTimersByTime(600 * 30); });

    expect(screen.getByRole("button", { name: /Stop simulation \(22\/22\)/ })).toBeInTheDocument();
    expect(screen.getByText("Points").nextSibling?.textContent).toBe("22");
    expect(screen.getByText("HaLow GNSS", { selector: "span" }).nextSibling?.textContent).toBe("16");
    expect(screen.getByText("E-Link only", { selector: "span" }).nextSibling?.textContent).toBe("6");

    fireEvent.click(screen.getByRole("button", { name: /Stop simulation/ }));
    expect(screen.getByText("Points").nextSibling?.textContent).toBe("0");
  });

  it("asks before clearing the recorded route and tells the backend", async () => {
    renderMap(route(["halow", "elink"], [-60, -70]));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear route" }));
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/route/clear"), expect.anything());

    confirm.mockReturnValue(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clear route" })); });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/route/clear"), { method: "POST" });
  });

  it("shows dashes, not numbers, before any telemetry", () => {
    renderMap();
    const position = screen.getByText("Balloon Position").parentElement!;
    expect(within(position).getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });
});
