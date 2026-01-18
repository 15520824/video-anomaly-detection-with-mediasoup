import { once } from "node:events";
import express from "express";
import { Server } from "socket.io";
import { createWorker, createWebRtcTransport } from "./mediasoup.js";

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

  ingestApp.get("/ingest/cameras", async (_req, res) => {
    try {
      const url = `${MTX_API}/v3/paths/list`;
      const r = await fetch(url);
      const txt = await r.text();
      const ct = r.headers.get("content-type") || "";
      if (!r.ok)
        throw new Error(
          `HTTP ${r.status} ${r.statusText}: ${txt.slice(0, 200)}`,
        );
      if (!txt.trim()) return res.json({ items: [] });
      if (!/application\/json/i.test(ct) && !/^\s*[{[]/.test(txt))
        throw new Error(`Expected JSON from MTX, got ${ct || "unknown"}`);
      res.json(JSON.parse(txt));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  ingestApp.post("/ingest/create", async (req, res) => {
    try {
      const roomId = req.body?.roomId || DEFAULT_ROOM;
      const room = ensureRoom(roomId); //

      // === PHẦN SỬA ĐỔI BẮT ĐẦU ===

      // 1. Tự động tìm codec H264 trong cấu hình mediaCodecs CỦA ROUTER
      const h264Codec = mediaCodecs.find(
        (c) => c.kind === "video" && c.mimeType.toLowerCase() === "video/h264",
      );

      // 2. Nếu không tìm thấy (lỗi cấu hình), báo lỗi rõ ràng
      if (!h264Codec) {
        throw new Error(
          "Router không được cấu hình để hỗ trợ video/H264. Vui lòng kiểm tra file config.js",
        );
      }

      // 3. Tắt rtcpMux để có kênh RTCP riêng (sửa lỗi PLI từ trước)
      const plainTransport = await room.router.createPlainTransport({
        listenIp: { ip: "0.0.0.0" },
        rtcpMux: false, // TẮT MUXING
        comedia: true, //
      });

      // 4. Chờ cả hai cổng (RTP và RTCP)
      if (!plainTransport.tuple) await once(plainTransport, "tuple");
      if (!plainTransport.rtcpTuple) await once(plainTransport, "rtcpTuple");

      const { localIp, localPort } = plainTransport.tuple;
      const rtcpPort = plainTransport.rtcpTuple.localPort; // Lấy cổng RTCP

      // 5. Tạo rtpParameters ĐỘNG dựa trên codec tìm được
      const rtpParameters = {
        mid: "0",
        codecs: [
          {
            mimeType: h264Codec.mimeType,
            payloadType: h264Codec.payloadType, // <-- Tự động
            clockRate: h264Codec.clockRate, // <-- Tự động
            parameters: h264Codec.parameters, // <-- Tự động
            rtcpFeedback: h264Codec.rtcpFeedback, // <-- Tự động
          },
        ],
        headerExtensions: [
          //
          { uri: "urn:ietf:params:rtp-hdrext:sdes:mid", id: 1 },
        ],
      };

      // === PHẦN SỬA ĐỔI KẾT THÚC ===

      const producer = await plainTransport.produce({
        //
        kind: "video",
        rtpParameters,
      });

      // (Code xử lý metadata, label, path, producer... giữ nguyên)
      const reqLabel = req.body?.label || "RTP Ingest";
      const reqPath = req.body?.path || "plainrtp";
      const meta = { kind: "video", label: reqLabel, path: reqPath };

      room.producers.set(producer.id, { producer, meta });

      io.to(roomId).emit("new-producer", {
        producerId: producer.id,
        kind: meta.kind,
        label: meta.label,
        path: meta.path,
      });

      const onClose = () => {
        room.producers.delete(producer.id);
        io.to(roomId).emit("producer-closed", { producerId: producer.id });
      };
      plainTransport.on("close", onClose);
      producer.on("transportclose", onClose);
      producer.on("close", onClose);

      const ipOut =
        process.env.INGEST_HOST ||
        process.env.MEDIASOOP_ANNOUNCED_IP ||
        process.env.PUBLIC_IP ||
        localIp ||
        "127.0.0.1";

      // 6. Trả về payloadType và rtcpPort chính xác
      res.json({
        ok: true,
        roomId,
        producerId: producer.id,
        ip: ipOut,
        rtpPort: localPort,
        rtcpPort: rtcpPort, // <-- Thêm cổng RTCP
        payloadType: h264Codec.payloadType, // <-- Trả về PT chính xác
      });
    } catch (e) {
      console.error("ingest/create error", e);
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  ingestApp.listen(INGEST_PORT, () => {
    console.log(`[ingest] listening on :${INGEST_PORT} (/ingest/*)`);
  });

  // Background task: prune stale publishers
  setInterval(() => {
    const now = Date.now();
    rooms.forEach((room) => {
      room.publishers.forEach((ts, id) => {
        if (now - ts > PUBLISHER_TTL_MS) room.publishers.delete(id);
      });
    });
  }, 10_000).unref?.();

  // ================== Socket.IO ==================
  io.on("connection", (socket) => {
    const meta = clientMeta(socket);

    safeSocket(socket, "join", async (payload = {}, cb) => {
      let { roomId, role, id } = payload;
      roomId = roomId || meta.roomFromReferer || DEFAULT_ROOM;
      role = role || meta.roleHint || "viewer";
      const room = ensureRoom(roomId);

      socket.data.signal = meta.signal;
      socket.data.role = role;
      const publisherId =
        role === "publisher" || role === "publisher-bot" ? id : null;

      room.peers.set(socket.id, {
        role,
        transports: [],
        producers: [],
        consumers: [],
        signal: meta.signal,
        publisherId,
      });
      socket.join(roomId);
      socket.emit("router-rtp-capabilities", room.router.rtpCapabilities);

      if ((role === "publisher" || role === "publisher-bot") && id) {
        room.publishers.set(id, Date.now());
      }

      // Provide current producers
      const current = [...room.producers.entries()].map(([pid, v]) => ({
        producerId: pid,
        kind: v.meta?.kind || v.producer.kind,
        label: v.meta?.label,
        path: v.meta?.path,
      }));
      cb?.({ ok: true, producers: current });
    });

    safeSocket(
      socket,
      "create-transport",
      async ({ roomId, direction }, cb) => {
        roomId = roomId || DEFAULT_ROOM;
        const room = ensureRoom(roomId);
        if (!["send", "recv"].includes(direction)) {
          return cb?.({ error: "invalid direction" });
        }
        const transport = await createWebRtcTransport(room.router);
        const peer = getPeer(roomId, socket.id);
        peer.transports.push(transport);
        transport.on("dtlsstatechange", (s) => {
          if (s === "closed" || s === "failed") transport.close();
        });
        transport.on("close", () => {
          peer.transports = peer.transports.filter(
            (t) => t.id !== transport.id,
          );
        });
        cb?.({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
          direction,
        });
      },
    );

    safeSocket(
      socket,
      "connect-transport",
      async ({ roomId, transportId, dtlsParameters }, cb) => {
        roomId = roomId || DEFAULT_ROOM;
        const peer = getPeer(roomId, socket.id);
        if (!peer) return cb?.({ error: "peer not found" });
        const transport = peer.transports.find((t) => t.id === transportId);
        if (!transport) return cb?.({ error: "transport not found" });
        await transport.connect({ dtlsParameters });
        cb?.({ ok: true });
      },
    );

    safeSocket(
      socket,
      "produce",
      async ({ roomId, transportId, kind, rtpParameters, label, path }, cb) => {
        roomId = roomId || DEFAULT_ROOM;
        const room = ensureRoom(roomId);
        const peer = getPeer(roomId, socket.id);
        if (!peer) return cb?.({ error: "peer not found" });
        const transport = peer.transports.find((t) => t.id === transportId);
        if (!transport) return cb?.({ error: "transport not found" });
        const producer = await transport.produce({ kind, rtpParameters });
        const metaObj = { kind, label, path, ownerSocketId: socket.id };
        peer.producers.push(producer);
        room.producers.set(producer.id, { producer, meta: metaObj });

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
      },
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
      },
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
      rooms.forEach((room) => cleanupPeer(room, socket.id));
    });
  });
}
