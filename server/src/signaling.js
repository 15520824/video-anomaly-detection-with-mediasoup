import { Server } from "socket.io";
import { createWorker, createWebRtcTransport } from "./mediasoup.js";
import express from "express";

export async function attachSignaling(httpServer) {
  const io = new Server(httpServer, { cors: { origin: "*" } });
  const rooms = new Map(); // roomId -> { router, peers: Map, producers: Map }
  const { router } = await createWorker();
  // ---- HTTP app để tạo PlainRTP ingest ----
  const ingestApp = express();
  ingestApp.use(express.json());
  const INGEST_PORT = Number(process.env.INGEST_PORT || 3100);

  // ===== MediaMTX Control API (v3) qua ingestApp trên :3100 =====
  const MTX_API = process.env.MTX_API || "http://mediamtx:9997";

  // Tạo path từ RTSP URL người dùng nhập: POST /ingest/cameras
  // body: { name: "cam1", rtspUrl: "rtsp://...", onDemand?: true, forceTCP?: true }
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
      const data = await r.json().catch(() => ({}));
      if (!r.ok)
        return res.status(r.status).json({ error: data || "mediamtx error" });

      res.json({ ok: true, path: name });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Liệt kê paths đang có: GET /ingest/cameras
  ingestApp.get("/ingest/cameras", async (_req, res) => {
    try {
      const r = await fetch(`${MTX_API}/v3/paths/list`);
      const data = await r.json();
      // MediaMTX trả { items: [...] }
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // helper lấy/khởi tạo room
  function ensureRoom(roomId) {
    if (!rooms.has(roomId))
      rooms.set(roomId, { router, peers: new Map(), producers: new Map() });
    return rooms.get(roomId);
  }

  // POST /ingest/create  -> tạo PlainTransport + Producer (H264)
  // body: { roomId: "lab", ssrc?: number, payloadType?: number }
  ingestApp.post("/ingest/create", async (req, res) => {
    try {
      const roomId = req.body?.roomId || "lab";
      const room = ensureRoom(roomId);

      const plainTransport = await room.router.createPlainTransport({
        listenIp: "0.0.0.0",
        rtcpMux: false, // dùng cặp RTP/RTCP (phù hợp ffmpeg)
        comedia: true, // học IP:port từ bên gửi
      });

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
      room.producers.set(producer.id, producer);

      // notify viewer
      io.to(roomId).emit("new-producer", {
        producerId: producer.id,
        kind: "video",
      });

      res.json({
        ok: true,
        roomId,
        producerId: producer.id,
        ip:
          process.env.MEDIASOUP_ANNOUNCED_IP ||
          process.env.PUBLIC_IP ||
          "127.0.0.1",
        rtpPort: plainTransport.tuple.localPort,
        rtcpPort: plainTransport.rtcpTuple.localPort,
        payloadType,
        ssrc,
      });
    } catch (e) {
      console.error("ingest/create error", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // gắn app HTTP vào httpServer
  ingestApp.listen(INGEST_PORT, () => {
    console.log(`[ingest] listening on :${INGEST_PORT} (/ingest/create)`);
  });
  // ------------------------------------------

  io.on("connection", (socket) => {
    socket.on("join", async ({ roomId, role }) => {
      if (!rooms.has(roomId))
        rooms.set(roomId, { router, peers: new Map(), producers: new Map() });
      const room = rooms.get(roomId);
      room.peers.set(socket.id, {
        role,
        transports: [],
        producers: [],
        consumers: [],
      });
      socket.join(roomId);
      socket.emit("router-rtp-capabilities", room.router.rtpCapabilities);
    });

    socket.on("create-transport", async ({ roomId, direction }, cb) => {
      const room = rooms.get(roomId);
      const transport = await createWebRtcTransport(room.router);
      rooms.get(roomId).peers.get(socket.id).transports.push(transport);
      cb({
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

    socket.on(
      "produce",
      async ({ roomId, transportId, kind, rtpParameters }, cb) => {
        const room = rooms.get(roomId);
        const peer = room.peers.get(socket.id);
        const transport = peer.transports.find((t) => t.id === transportId);
        const producer = await transport.produce({ kind, rtpParameters });
        peer.producers.push(producer);
        room.producers.set(producer.id, producer);
        socket
          .to(roomId)
          .emit("new-producer", { producerId: producer.id, kind });
        cb({ id: producer.id });
      }
    );

    socket.on("list-producers", ({ roomId }, cb) => {
      const room = rooms.get(roomId);
      cb({
        producers: [...room.producers.values()].map((p) => ({
          id: p.id,
          kind: p.kind,
        })),
      });
    });

    socket.on(
      "consume",
      async ({ roomId, transportId, producerId, rtpCapabilities }, cb) => {
        const room = rooms.get(roomId);
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

    socket.on("disconnect", () => {
      rooms.forEach(({ peers }) => peers.delete(socket.id));
    });
  });
}
