import React from "react";
import MosaicViewer from "./components/MosaicViewer";
import StatsPanel from "./components/StatsPanel";
import { BrowserRouter, Routes, Route } from "react-router-dom";

export default function App() {
  return (
    <div className="container">
      <header className="header">
        <h1>Camera live (Mosaic)</h1>
        <p>Viewer React</p>
      </header>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<StatsPanel />} />
          <Route path="/viewer/:roomId" element={<MosaicViewer />} />
        </Routes>
      </BrowserRouter>
    </div>
  );
}
