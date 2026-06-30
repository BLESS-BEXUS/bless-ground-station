import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useLiveData, GROUND_STATION } from "@/hooks/useLiveData";

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Slant range (straight line GS→balloon, accounting for altitude) */
function slantRangeKm(lat1: number, lon1: number, alt1m: number, lat2: number, lon2: number, alt2m: number): number {
  const groundKm = haversineKm(lat1, lon1, lat2, lon2);
  const altDiffKm = (alt2m - alt1m) / 1000;
  return Math.sqrt(groundKm ** 2 + altDiffKm ** 2);
}

const balloonIcon = L.divIcon({
  html: `<div style="width:14px;height:14px;background:#A5BB86;border-radius:50%;border:2px solid #183054;box-shadow:0 0 10px #A5BB86;"></div>`,
  iconSize: [14, 14], iconAnchor: [7, 7], className: "",
});

const gsIcon = L.divIcon({
  html: `<div style="width:16px;height:16px;background:#28808D;border-radius:3px;border:2px solid #183054;box-shadow:0 0 10px #28808D;"></div>`,
  iconSize: [16, 16], iconAnchor: [8, 8], className: "",
});

function MapFollower({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { map.setView([lat, lng], 10); first.current = false; }
    else map.panTo([lat, lng]);
  }, [lat, lng, map]);
  return null;
}

export default function MapPage() {
  const { telemetry: sim } = useLiveData();

  const groundDist = haversineKm(sim.latitude, sim.longitude, GROUND_STATION.lat, GROUND_STATION.lng);
  const slantDist = slantRangeKm(GROUND_STATION.lat, GROUND_STATION.lng, GROUND_STATION.alt, sim.latitude, sim.longitude, sim.altitude);

  const trajectory: [number, number][] = sim.trajectoryHistory.map((p) => [p.lat, p.lng]);
  const losLine: [number, number][] = [
    [sim.latitude, sim.longitude],
    [GROUND_STATION.lat, GROUND_STATION.lng],
  ];

  return (
    <div className="flex h-[calc(100vh-57px)]">
      {/* Sidebar */}
      <div className="w-80 border-r border-border bg-card p-5 space-y-5 flex-shrink-0 overflow-y-auto">
        <h2 className="font-mono text-sm text-primary uppercase tracking-wider text-glow-primary">Tracking Data</h2>

        <div className="space-y-3">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Balloon Position</div>
          <DataRow label="Latitude" value={sim.latitude.toFixed(6) + "°"} />
          <DataRow label="Longitude" value={sim.longitude.toFixed(6) + "°"} />
          <DataRow label="Altitude" value={sim.altitude.toFixed(0) + " m"} />
          <DataRow label="GPS Fix" value={sim.gpsFix ? `YES (${sim.gpsSats} sats)` : "NO FIX"} warn={!sim.gpsFix} />
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Ground Station</div>
          <DataRow label="Location" value={GROUND_STATION.name} />
          <DataRow label="Latitude" value={GROUND_STATION.lat.toFixed(6) + "°"} />
          <DataRow label="Longitude" value={GROUND_STATION.lng.toFixed(6) + "°"} />
          <DataRow label="Altitude" value={GROUND_STATION.alt + " m"} />
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Link Geometry</div>
          <DataRow label="Ground dist." value={groundDist.toFixed(2) + " km"} accent />
          <DataRow label="Slant range" value={slantDist.toFixed(2) + " km"} accent />
          <DataRow label="Phase" value={sim.halowStatus} />
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">RF</div>
          <DataRow label="RSSI" value={sim.rssi.toFixed(1) + " dBm"} />
          <DataRow label="SNR" value={sim.snr.toFixed(1) + " dB"} />
          <DataRow label="PDR" value={sim.successRate + "%"} />
          <DataRow label="Packets RX" value={String(sim.packetCount)} />
        </div>
      </div>

      {/* Map */}
      <div className="flex-1 relative" style={{ minHeight: "400px" }}>
        <MapContainer center={[sim.latitude, sim.longitude]} zoom={10} style={{ height: "100%", width: "100%" }} zoomControl={false}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <MapFollower lat={sim.latitude} lng={sim.longitude} />
          <Marker position={[sim.latitude, sim.longitude]} icon={balloonIcon}>
            <Popup>
              <b>Balloon</b><br />
              Alt: {sim.altitude.toFixed(0)} m<br />
              RSSI: {sim.rssi.toFixed(1)} dBm
            </Popup>
          </Marker>
          <Marker position={[GROUND_STATION.lat, GROUND_STATION.lng]} icon={gsIcon}>
            <Popup>{GROUND_STATION.name}</Popup>
          </Marker>
          <Polyline positions={trajectory} pathOptions={{ color: "#A5BB86", weight: 2, opacity: 0.7 }} />
          <Polyline positions={losLine} pathOptions={{ color: "#6AB1A7", weight: 1, dashArray: "8 4", opacity: 0.5 }} />
        </MapContainer>
      </div>
    </div>
  );
}

function DataRow({ label, value, accent, warn }: {
  label: string; value: string; accent?: boolean; warn?: boolean;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold ${
        warn ? "text-destructive" : accent ? "text-tertiary text-glow-tertiary" : "text-foreground"
      }`}>
        {value}
      </span>
    </div>
  );
}
