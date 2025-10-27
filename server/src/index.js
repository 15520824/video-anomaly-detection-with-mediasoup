import express from "express";
import http from "http";
import cfg from "../config.js";
import { attachSignaling } from "./signaling.js";

const app = express();
app.get("/", (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
attachSignaling(server).then(() => {
  server.listen(cfg.webPort, "0.0.0.0", () => {
    console.log(`Signaling on :${cfg.webPort}`);
  });
});
