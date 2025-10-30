import React from "react";
import MosaicViewer from "./components/MosaicViewer";
import StatsPanel from "./components/StatsPanel";
import { BrowserRouter, Routes, Route } from "react-router-dom";

export default function App() {
  return (
    <div className="container">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<StatsPanel />} />
          <Route path="/viewer/:roomId" element={<MosaicViewer />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}
