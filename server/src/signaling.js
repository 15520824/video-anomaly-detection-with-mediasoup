import { Server } from "socket.io";
import { createWorker, createWebRtcTransport } from "./mediasoup.js";
import express from "express";

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
      let data = {};
      try {
        data = txt ? JSON.parse(txt) : {};
      } catch {}
      if (!r.ok)
        return res
          .status(r.status)
          .json({ error: data || txt || "mediamtx error" });
      res.json({ ok: true, path: name, mtx: data });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // List MTX paths: GET /ingest/cameras
  ingestApp.get("/ingest/cameras", async (_req, res) => {
    try {
      const url = `${MTX_API}/v3/paths/list`;
      const r = await fetch(url);
      const txt = await r.text();
      const ct = r.headers.get("content-type") || "";
      if (!r.ok)
        throw new Error(
          `HTTP ${r.status} ${r.statusText}: ${txt.slice(0, 200)}`
        );
      if (!txt.trim()) return res.json({ items: [] });
      if (!/application\/json/i.test(ct) && !/^\s*[{[]/.test(txt)) {
        throw new Error(`Expected JSON from MTX, got ${ct || "unknown"}`);
      }
      const data = JSON.parse(txt);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Helper: ensure room
  function ensureRoom(roomId) {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        router,
        peers: new Map(),
        producers: new Map(), // producerId -> { producer, meta: {label,path,kind,ownerSocketId?} }
        publishers: new Map(), // publisherId -> lastSeen ms
      });
    }
    return rooms.get(roomId);
  }

  // Helper: extract client meta (signal source, referer-derived room)
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
        roomFromReferer = segs[segs.length - 1] || null;
      }
    } catch {}
    return {
      roleHint: auth.role || q.role,
      signal: auth.signal || q.signal || signalHdr || "unknown",
      roomFromReferer,
    };
  }

  // POST /ingest/create → create PlainTransport + Producer(H264) (for ffmpeg/MediaMTX -> RTP ingest)
  // body: { roomId: "lab", ssrc?: number, payloadType?: number }
  ingestApp.post("/ingest/create", async (req, res) => {
    try {
      const roomId = req.body?.roomId || "lab";
      const room = ensureRoom(roomId);

      // 1) PlainRTP: 1 cổng (rtcpMux) + comedia
      const plainTransport = await room.router.createPlainTransport({
        listenIp: { ip: "0.0.0.0" },
        rtcpMux: true,
        comedia: true,
      });

      // 2) Đợi tuple sẵn sàng (nếu chưa có)
      if (!plainTransport.tuple) {
        await once(plainTransport, "tuple");
      }
      const { localIp, localPort } = plainTransport.tuple;

      // 3) Thông số RTP
      const payloadType = Number(req.body?.payloadType ?? 101);
      const ssrc = Number(
        req.body?.ssrc ?? Math.floor(Math.random() * 0xffffffff)
      );

      const rtpParameters = {
        codecs: [
          {
            mimeType: "video/H264",
            payloadType,
            clockRate: 90000,
            parameters: {
              "packetization-mode": 1,
              "profile-level-id": "42e01f",
              "level-asymmetry-allowed": 1,
            },
            rtcpFeedback: [
              { type: "nack" },
              { type: "nack", parameter: "pli" },
              { type: "ccm", parameter: "fir" },
              { type: "transport-cc" },
            ],
          },
        ],
        encodings: [{ ssrc }],
        headerExtensions: [
          { uri: "urn:ietf:params:rtp-hdrext:sdes:mid", id: 1 },
        ],
      };

      const producer = await plainTransport.produce({
        kind: "video",
        rtpParameters,
      });

      room.producers.set(producer.id, {
        producer,
        meta: { kind: "video", label: "RTP Ingest", path: "plainrtp" },
      });

      io.to(roomId).emit("new-producer", {
        producerId: producer.id,
        kind: "video",
        label: "RTP Ingest",
        path: "plainrtp",
      });

      const onClose = () => {
        room.producers.delete(producer.id);
        io.to(roomId).emit("producer-closed", { producerId: producer.id });
      };
      plainTransport.on("close", onClose);
      producer.on("transportclose", onClose);
      producer.on("close", onClose);

      // 4) Trả thông tin cho bot publisher
      const ipOut =
        process.env.INGEST_HOST || // ví dụ: "mediasoup-server" trong docker
        process.env.MEDIASOUP_ANNOUNCED_IP ||
        process.env.PUBLIC_IP ||
        localIp ||
        "127.0.0.1";

      res.json({
        ok: true,
        roomId,
        producerId: producer.id,
        ip: ipOut,
        rtpPort: localPort, // chỉ 1 cổng do rtcpMux: true
        payloadType,
        ssrc,
        ffmpegExample: `ffmpeg -re -i input.mp4 -an -c:v libx264 -profile:v baseline -tune zerolatency -b:v 2M -maxrate 2M -bufsize 4M -f rtp "rtp://${ipOut}:${localPort}?pkt_size=1200"`,
      });
    } catch (e) {
      console.error("ingest/create error", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  ingestApp.listen(INGEST_PORT, () => {
    console.log(`[ingest] listening on :${INGEST_PORT} (/ingest/*)`);
  });

  // ================== Socket.IO signaling ==================
  io.on("connection", (socket) => {
    const meta = clientMeta(socket);

    socket.on("join", async (payload = {}) => {
      let { roomId, role, id, label, path } = payload;
      roomId = roomId || meta.roomFromReferer || "lab";
      role = role || meta.roleHint || "viewer";

      const room = ensureRoom(roomId);
      socket.data.signal = meta.signal;
      socket.data.role = role;

      room.peers.set(socket.id, {
        role,
        transports: [],
        producers: [],
        consumers: [],
        signal: meta.signal,
      });
      socket.join(roomId);
      socket.emit("router-rtp-capabilities", room.router.rtpCapabilities);

      // track publisher bots as well
      if ((role === "publisher" || role === "publisher-bot") && id) {
        room.publishers.set(id, Date.now());
      }
    });

    socket.on("create-transport", async ({ roomId, direction }, cb) => {
      const room = ensureRoom(roomId);
      const transport = await createWebRtcTransport(room.router);
      room.peers.get(socket.id).transports.push(transport);

      transport.on("dtlsstatechange", (s) => {
        if (s === "closed" || s === "failed") transport.close();
      });

      cb?.({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    });

    socket.on(
      "connect-transport",
      async ({ transportId, dtlsParameters }, cb) => {
        const peer = [...rooms.values()]
          .flatMap((r) => [...r.peers])
          .find(([id]) => id === socket.id);
        if (!peer) return;
        const transport = peer[1].transports.find((t) => t.id === transportId);
        await transport.connect({ dtlsParameters });
        cb && cb();
      }
    );

    // Producer creation (browser or bot)
    socket.on(
      "produce",
      async ({ roomId, transportId, kind, rtpParameters, label, path }, cb) => {
        const room = ensureRoom(roomId);
        const peer = room.peers.get(socket.id);
        const transport = peer.transports.find((t) => t.id === transportId);
        const producer = await transport.produce({ kind, rtpParameters });
        const meta = { kind, label, path, ownerSocketId: socket.id };
        peer.producers.push(producer);
        room.producers.set(producer.id, { producer, meta });

        // lifecycle
        const onClose = () => {
          room.producers.delete(producer.id);
          io.to(roomId).emit("producer-closed", { producerId: producer.id });
        };
        producer.on("close", onClose);
        producer.on("transportclose", onClose);

        socket
          .to(roomId)
          .emit("new-producer", { producerId: producer.id, kind, ...meta });
        cb({ id: producer.id });
      }
    );

    // List producers with metadata for UI filtering
    socket.on("list-producers", ({ roomId }, cb) => {
      const room = ensureRoom(roomId);
      cb({
        producers: [...room.producers.entries()].map(([id, value]) => ({
          id,
          kind: value.meta?.kind || value.producer.kind,
          label: value.meta?.label,
          path: value.meta?.path,
        })),
      });
    });

    // Single producer info (used when catching new-producer)
    socket.on("get-producer-info", ({ roomId, producerId }, cb) => {
      const room = ensureRoom(roomId);
      const entry = room.producers.get(producerId);
      cb({
        info: entry
          ? { id: producerId, ...entry.meta, kind: entry.producer.kind }
          : null,
      });
    });

    // Consumer
    socket.on(
      "consume",
      async ({ roomId, transportId, producerId, rtpCapabilities }, cb) => {
        const room = ensureRoom(roomId);
        if (!room.router.canConsume({ producerId, rtpCapabilities }))
          return cb({ error: "cannot consume" });
        const peer = room.peers.get(socket.id);
        const transport = peer.transports.find((t) => t.id === transportId);
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
        });
        peer.consumers.push(consumer);
        cb({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      }
    );

    socket.on("resume", async ({ consumerId }) => {
      const peer = [...rooms.values()]
        .flatMap((r) => [...r.peers])
        .find(([id]) => id === socket.id);
      if (!peer) return;
      const consumer = peer[1].consumers.find((c) => c.id === consumerId);
      if (consumer) await consumer.resume();
    });

    // === UI → Publisher control ===
    socket.on("start-camera", (payload) => {
      // payload: { roomId, id, label, path, rtspUrl }
      const roomId = payload?.roomId || "lab";
      ensureRoom(roomId);
      // Optionally, only emit to known bots by a tag
      // Here we broadcast; bots filter by event name
      io.emit("start-camera", payload);
    });

    socket.on("stop-camera", (payload) => {
      io.emit("stop-camera", payload);
    });

    // Publisher keepalive for status display
    socket.on("publisher-keepalive", ({ roomId, id }) => {
      const room = ensureRoom(roomId || "lab");
      if (id) room.publishers.set(id, Date.now());
    });

    socket.on("disconnect", () => {
      rooms.forEach(({ peers }) => peers.delete(socket.id));
    });
  });
}
