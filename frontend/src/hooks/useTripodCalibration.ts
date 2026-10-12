import { useCallback, useEffect, useState } from "react";
import {
  loadTripodCalibration,
  saveTripodCalibration,
  TRIPOD_CALIBRATION_STORAGE_KEY,
  type TripodCalibration,
} from "@/lib/tripodCalibration";

/** The saved tripod calibration, kept in step with other tabs of the same browser. */
export function useTripodCalibration() {
  const [calibration, setCalibrationState] = useState<TripodCalibration | null>(loadTripodCalibration);

  const setCalibration = useCallback((next: TripodCalibration | null) => {
    saveTripodCalibration(next);
    setCalibrationState(next);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== TRIPOD_CALIBRATION_STORAGE_KEY) return;
      setCalibrationState(loadTripodCalibration());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { calibration, setCalibration };
}
