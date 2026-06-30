import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveDataProvider } from "@/hooks/useLiveData";
import TopNav from "@/components/TopNav";
import Index from "@/pages/Index";
import TelemetryPage from "@/pages/TelemetryPage";
import ELinkPage from "@/pages/ELinkPage";
import MapPage from "@/pages/MapPage";
import AntennaPage from "@/pages/AntennaPage";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <LiveDataProvider>
        <BrowserRouter>
          <TopNav />
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/telemetry" element={<TelemetryPage />} />
            <Route path="/elink" element={<ELinkPage />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/antenna" element={<AntennaPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </LiveDataProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
