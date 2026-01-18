
/**
 * signaling.js (enhanced)
 * - Added robust error guards, cleanup, and publisher pruning
 * - Added endpoints: /ingest/publishers, /ingest/health
 * - Added producer control events (pause/resume/close)
 * - Added join auto-listing of current producers
 * - Unified peer lookup and safe socket handlers
 */

const DEFAULT_ROOM = "lab";
const PUBLISHER_TTL_MS = 30_000;

export async function attachSignaling(httpServer) {
  const io = new Server(httpServer, { cors: { origin: "*" } });

  const rooms = new Map();
  const { router, mediaCodecs } = await createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 40020,
  });

  function ensureRoom(roomId) {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        router,
        peers: new Map(), // socketId -> { role, transports, producers, consumers, signal }
        producers: new Map(), // producerId -> { producer, meta }
        publishers: new Map(), // publisherId -> lastSeen timestamp
      });
    }
    return rooms.get(roomId);
  }

  function clientMeta(socket) {
    const auth = socket.handshake.auth || {};
    const q = socket.handshake.query || {};
    const headers = socket.handshake.headers || {};
    const signalHdr = headers["x-signal-source"];
    let roomFromReferer = null;
    try {
      const ref = headers.referer;
      if (ref) {
        const u = new URL(ref);
        const segs = u.pathname.split("/").filter(Boolean);
        roomFromReferer = segs.at(-1) || null;
      }
    } catch {}
    return {
      roleHint: auth.role || q.role,
      signal: auth.signal || q.signal || signalHdr || "unknown",
      roomFromReferer,
    };
  }

  function getPeer(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room) return null;
    return room.peers.get(socketId) || null;
  }

  function safeSocket(socket, event, handler) {
    socket.on(event, async (...args) => {
      try {
        await handler(...args);
      } catch (e) {
        if (typeof args.at(-1) === "function") {
          args.at(-1)({ error: String(e) });
        }
        console.error(`socket handler error in "${event}"`, e);
      }
    });
  }

  // ===== HTTP ingest/control app =====
  const ingestApp = express();
  ingestApp.use(express.json());
  ingestApp.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  const INGEST_PORT = Number(process.env.INGEST_PORT || 3100);
  const MTX_API = process.env.MTX_API || "http://mediamtx:9997";

  ingestApp.get("/ingest/health", (_req, res) => {
    res.json({
      ok: true,
      rooms: [...rooms.keys()],
      producers: [...rooms.entries()].reduce(
        (acc, [roomId, r]) => ({ ...acc, [roomId]: r.producers.size }),
        {},
      ),
    });
  });

  ingestApp.get("/ingest/publishers", (_req, res) => {
    const now = Date.now();
    const out = [...rooms.entries()].map(([roomId, room]) => ({
      roomId,
      publishers: [...room.publishers.entries()]
        .filter(([, ts]) => now - ts < PUBLISHER_TTL_MS)
        .map(([id, ts]) => ({ id, lastSeen: ts })),
    }));
    res.json({ items: out });
  });

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
        },
      );
      const txt = await r.text();
      declare interface dataType {
	setInterval(const: any, now: any, now: any, rooms: any, forEach: any, room: any, room: any, publishers: any, forEach: any, ts: any, id: any, if: any, now: any, ts: any, PUBLISHER_TTL_MS: any, room: any, publishers: any, delete: any, id: any, 10_000: any, unref: any, Socket: any, IO: any, io: any, on: any, connection: any, socket: any, const: any, meta: any, socket: any, safeSocket: any, socket: any, join: any, async: any, payload: any, cb: any, let: any, roomId: any, role: any, id: any, payload: any, roomId: any, meta: any, roomFromReferer: any, DEFAULT_ROOM: any, role: any, meta: any, roleHint: any, viewer: any, const: any, room: any, roomId: any, socket: any, data: any, signal: any, signal: any, socket: any, data: any, role: any, const: any, publisherId: any, publisher: any, role: any, publisher: any, bot: any, id: any, null: any, room: any, peers: any, set: any, socket: any, id: any, role: any, transports: any, producers: any, consumers: any, signal: any, meta: any, signal: any, publisherId: any, socket: any, join: any, roomId: any, socket: any, emit: any, router: any, rtp: any, capabilities: any, room: any, router: any, rtpCapabilities: any, if: any, role: any, publisher: any, role: any, publisher: any, bot: any, id: any): {	} | null;
}
