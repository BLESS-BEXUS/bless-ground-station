import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StationEquipmentCard from "@/components/StationEquipmentCard";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

const defaults = {
  groundAntenna: { gainDbi: null, polarization: "unknown" },
  groundLna: { present: null, gainDb: null },
  groundCableLossDb: null,
  notes: "",
  updatedAt: null,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(equipment: unknown = defaults) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? json({ ok: true, equipment: JSON.parse(String(init.body)) }) : json({ equipment }));
  render(<StationEquipmentCard />);
  await screen.findByText("Ground station equipment");
}

const posted = () => fetchMock.mock.calls
  .filter(([, init]) => init?.method === "POST")
  .map(([, init]) => JSON.parse(String(init.body)));

describe("ground station equipment card", () => {
  it("waits for the backend instead of showing made-up values", () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<StationEquipmentCard />);
    expect(screen.getByText(/waiting for the backend/)).toBeInTheDocument();
  });

  it("starts empty and says nothing has been entered", async () => {
    await open();
    expect(screen.getByText(/Not entered yet/)).toBeInTheDocument();
    expect(screen.getByLabelText("Antenna gain (dBi)")).toHaveValue(null);
    expect(screen.getByLabelText("LNA gain (dB)")).toHaveValue(null);
    expect(screen.getByLabelText("LNA")).toHaveValue("");
  });

  it("asks for the ground side only: no payload fields and no model names", async () => {
    await open();
    expect(screen.queryByText(/Payload/)).toBeNull();
    expect(screen.queryByText(/model/i)).toBeNull();
    expect(screen.queryByText(/TX power at boot/)).toBeNull();
  });

  it("shows when the operator confirmed it", async () => {
    await open({ ...defaults, updatedAt: "2026-10-15T09:00:00.000Z", groundAntenna: { gainDbi: 12, polarization: "vertical" } });
    expect(screen.getByText(/^Confirmed /)).toBeInTheDocument();
    expect(screen.getByLabelText("Antenna gain (dBi)")).toHaveValue(12);
    expect(screen.getByLabelText("Antenna polarization")).toHaveValue("vertical");
  });

  it("sends what was typed, with empty fields as null", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Antenna gain (dBi)"), { target: { value: "10.5" } });
    fireEvent.change(screen.getByLabelText("Antenna polarization"), { target: { value: "rhcp" } });
    fireEvent.change(screen.getByLabelText("LNA"), { target: { value: "yes" } });
    fireEvent.change(screen.getByLabelText("LNA gain (dB)"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Radar Hill" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save equipment" })); });

    const [body] = posted();
    expect(body.groundAntenna).toEqual({ gainDbi: 10.5, polarization: "rhcp" });
    expect(body.groundLna).toEqual({ present: true, gainDb: 20 });
    expect(body.groundCableLossDb).toBeNull();
    expect(body.notes).toBe("Radar Hill");
    expect(Object.keys(body).sort()).toEqual(["groundAntenna", "groundCableLossDb", "groundLna", "notes", "updatedAt"]);
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
  });

  it("clearing a value sends null, not zero", async () => {
    await open({ ...defaults, updatedAt: "2026-10-15T09:00:00.000Z", groundCableLossDb: 1.5 });
    fireEvent.change(screen.getByLabelText("Cable and connector loss (dB)"), { target: { value: "" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save equipment" })); });
    expect(posted()[0].groundCableLossDb).toBeNull();
  });

  it("shows the backend's reason when it refuses the values", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ ok: false, error: "groundAntenna.gainDbi must be a number between -20 and 60, or empty" }, 400)
        : json({ equipment: defaults }));
    render(<StationEquipmentCard />);
    await screen.findByText("Ground station equipment");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save equipment" })); });
    expect(await screen.findByText(/gainDbi must be a number/)).toBeInTheDocument();
  });
});
