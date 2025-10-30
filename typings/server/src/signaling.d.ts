
/**
 * Goals of this revision:
 * 1) Expose ingest HTTP API (MediaMTX proxy) with robust JSON handling & CORS
 * 2) Add producer metadata (label, path) so UI can filter
 * 3) Broadcast `new-producer` with metadata; support `producer-closed`
 * 4) Forward UI → publisher bot control via `start-camera` / `stop-camera`
 * 5) Provide optional keepalive for publisher status
 */

export async function attachSignaling(httpServer) {
  const io = new Server(httpServer, { cors: { origin: "*" } });

  const rooms = new Map(); // roomId -> { router, peers: Map, producers: Map<string, { producer, meta }>, publishers: Map<publisherId,lastSeen> }
  const { router } = await createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 40020,
  });

  // ===== HTTP app for ingest & MediaMTX control =====
  const ingestApp = express();
  ingestApp.use(express.json());

  // Simple CORS so the web UI can call /ingest/* directly through reverse proxy
  ingestApp.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  const INGEST_PORT = Number(process.env.INGEST_PORT || 3100);
  const MTX_API = process.env.MTX_API || "http://mediamtx:9997";

  // Create MTX path from RTSP URL: POST /ingest/cameras
  // body: { name, rtspUrl, onDemand?: true, forceTCP?: true }
  ingestApp.post("/ingest/cameras", async (req, res) => {
    try {
      const {
        name,
        rtspUrl,
        onDemand = true,
        forceTCP = true,
      } = req.body || {};
      if (!name || !rtspUrl)
        return res.status(400).json({ error: "name & rtspUrl required" });

      const r = await fetch(
        `${MTX_API}/v3/config/paths/add/${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: rtspUrl,
            sourceOnDemand: !!onDemand,
            ...(forceTCP ? { sourceProtocol: "tcp" } : {}),
          }),
        }
      );

      const txt = await r.text();
      declare interface dataType {}
