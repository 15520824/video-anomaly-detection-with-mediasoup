import React, { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import { socket } from "../lib/socket";

type ProducerInfo = { id: string; kind: string; label?: string };

export default function MosaicViewer() {
  const [gridSize, setGridSize] = useState(2);
  const [loading, setLoading] = useState(true);
  const maxTiles = gridSize * gridSize;

  const roomId = window.location.pathname.split("/").pop() || "default-room";

  const deviceRef = useRef<mediasoupClient.Device>(null);
  const recvTransportRef = useRef<mediasoupClient.types.Transport>(null);
  const consumersRef = useRef(
    new Map<string, mediasoupClient.types.Consumer>()
  );
  const tilesRef = useRef(new Map<string, HTMLDivElement>());
  const gridRef = useRef<HTMLDivElement>(null);

  const emitAck = (event: string, payload: any) =>
    new Promise<any>((resolve) =>
      socket.emit(event, payload, (res: any) => resolve(res))
    );

  useEffect(() => {
    let mounted = true;
    (async () => {
      await new Promise<void>((res) =>
        socket.connected ? res() : socket.once("connect", () => res())
      );
      socket.emit("join", { roomId, role: "viewer" });

      const routerCaps = await new Promise<any>((res) =>
        socket.once("router-rtp-capabilities", (caps) => res(caps))
      );
      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: routerCaps });
      if (!mounted) return;
      deviceRef.current = device;

      const params = await emitAck("create-transport", {
        roomId,
        direction: "recv",
      });
      const recvTransport = device.createRecvTransport(params);
      recvTransport.on("connect", ({ dtlsParameters }, cb) => {
        socket.emit(
          "connect-transport",
          { transportId: (recvTransport as any).id, dtlsParameters },
          cb
        );
      });
      recvTransportRef.current = recvTransport;

      await reloadProducers();

      const onNewProducer = async ({
        producerId,
        kind,
      }: {
        producerId: string;
        kind: string;
      }) => {
        if (kind !== "video") return;
        if (consumersRef.current.has(producerId)) return;
        if (consumersRef.current.size >= maxTiles) return;
        await consumeOne(producerId);
      };
      socket.on("new-producer", onNewProducer);

      setLoading(false);

      return () => {
        mounted = false;
        socket.off("new-producer", onNewProducer);
        consumersRef.current.forEach((c) => {
          try {
            c.close();
          } catch {}
        });
        consumersRef.current.clear();
      };
    })();
  }, [roomId]);

  const reloadProducers = async () => {
    const result = await emitAck("list-producers", { roomId });
    const list: ProducerInfo[] = (result?.producers || []).filter(
      (p: ProducerInfo) => p.kind === "video"
    );

    console.log("Producers in room:", list);

    for (const id of Array.from(consumersRef.current.keys())) {
      if (!list.find((p) => p.id === id)) removeTile(id);
    }
    for (const p of list) {
      if (consumersRef.current.size >= maxTiles) break;
      if (!consumersRef.current.has(p.id)) await consumeOne(p.id);
    }
    arrangeGrid();
  };

  const consumeOne = async (producerId: string) => {
    const device = deviceRef.current!;
    const recvTransport = recvTransportRef.current!;
    const params = await emitAck("consume", {
      roomId,
      transportId: (recvTransport as any).id,
      producerId,
      rtpCapabilities: device.rtpCapabilities,
    });
    if (params?.error) {
      console.error(params.error);
      return;
    }

    const consumer = await recvTransport.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters,
    });
    consumersRef.current.set(producerId, consumer);

    const cell = document.createElement("div");
    cell.className = "cell";
    const v = document.createElement("video");
    v.autoplay = true;
    v.playsInline = true;
    (v as any).muted = true;
    v.srcObject = new MediaStream([consumer.track as MediaStreamTrack]);

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = producerId.slice(0, 8);

    const muted = document.createElement("div");
    muted.className = "muted";
    muted.textContent = "muted";

    cell.appendChild(v);
    cell.appendChild(label);
    cell.appendChild(muted);

    tilesRef.current.set(producerId, cell);
    gridRef.current?.appendChild(cell);

    socket.emit("resume", { consumerId: consumer.id });
  };

  const removeTile = (producerId: string) => {
    const consumer = consumersRef.current.get(producerId);
    try {
      consumer?.close();
    } catch {}
    consumersRef.current.delete(producerId);

    const el = tilesRef.current.get(producerId);
    if (el?.parentNode) el.parentNode.removeChild(el);
    tilesRef.current.delete(producerId);
  };

  const arrangeGrid = () => {
    if (!gridRef.current) return;
    gridRef.current.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;
  };

  return (
    <section>
      <div className="toolbar">
        <label>Layout:</label>
        <select
          value={gridSize}
          onChange={(e) =>
            setGridSize(Number((e.target as HTMLSelectElement).value))
          }
        >
          <option value={2}>2×2 (tối đa 4)</option>
          <option value={3}>3×3 (tối đa 9)</option>
        </select>
        <button onClick={reloadProducers} disabled={loading}>
          {loading ? "Loading…" : "Reload producers"}
        </button>
      </div>
      <div id="grid" ref={gridRef} className="grid" />
    </section>
  );
}
