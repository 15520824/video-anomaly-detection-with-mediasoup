import React, { useEffect, useMemo, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import { socket } from "../lib/socket";

export type ProducerInfo = {
  id: string;
  kind: "audio" | "video";
  label?: string;
  path?: string;
};

type Props = {
  selectedLabels?: string[];
  autoGrid?: boolean;
};

export default function MosaicViewer({
  selectedLabels,
  autoGrid = true,
}: Props) {
  const [gridSize, setGridSize] = useState(2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emptyMsg, setEmptyMsg] = useState<string | null>(null);

  const urlSelected = useMemo(() => {
    if (selectedLabels?.length)
      return selectedLabels.map((s) => s.trim()).filter(Boolean);
    const usp = new URLSearchParams(window.location.search);
    const raw = usp.get("cams");
    if (!raw) return [] as string[];
    return raw
      .split(",")
      .map((s) => decodeURIComponent(s.trim()))
      .filter(Boolean);
  }, [selectedLabels]);

  const effectiveSelected = urlSelected;
  const roomId = useMemo(
    () =>
      window.location.pathname.split("/").filter(Boolean).pop() ||
      "default-room",
    []
  );

  const deviceRef = useRef<mediasoupClient.Device | null>(null);
  const recvTransportRef = useRef<mediasoupClient.types.Transport | null>(null);
  const consumersRef = useRef(
    new Map<string, mediasoupClient.types.Consumer>()
  );
  const tilesRef = useRef(new Map<string, HTMLDivElement>());
  const infoRef = useRef(new Map<string, ProducerInfo>());
  const gridRef = useRef<HTMLDivElement>(null);

  const emitAck = (event: string, payload: any) =>
    new Promise<any>((resolve) =>
      socket.emit(event, payload, (res: any) => resolve(res))
    );

  const matchSelection = (info?: ProducerInfo) => {
    if (!info) return false;
    if (!effectiveSelected.length) return true;
    const label = (info.label || info.path || "").toLowerCase();
    return effectiveSelected.some((sel) => label.includes(sel.toLowerCase()));
  };

  const arrangeGrid = () => {
    if (!gridRef.current) return;
    const n = Math.max(1, consumersRef.current.size);
    if (autoGrid) {
      const g = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(n))));
      gridRef.current.style.gridTemplateColumns = `repeat(${g}, 1fr)`;
      setGridSize(g);
    } else {
      gridRef.current.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;
    }
  };

  const safeAppend = (el?: HTMLElement) =>
    el && gridRef.current?.appendChild(el);

  useEffect(() => {
    let mounted = true;
    let reconnecting = false;

    setError(null);
    setEmptyMsg(null);
    setLoading(true);

    const start = async () => {
      try {
        await new Promise<void>((res) =>
          socket.connected ? res() : socket.once("connect", () => res())
        );
        if (!mounted) return;

        socket.emit("join", { roomId, role: "viewer" });

        const routerCaps = await new Promise<any>((res) =>
          socket.once("router-rtp-capabilities", (caps) => res(caps))
        );
        if (!mounted) return;

        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: routerCaps });
        if (!mounted) return;
        deviceRef.current = device;

        const tParams = await emitAck("create-transport", {
          roomId,
          direction: "recv",
        });
        if (tParams?.error)
          throw new Error(tParams.error || "create-transport failed");

        const recvTransport = device.createRecvTransport(tParams);
        recvTransport.on("connect", ({ dtlsParameters }, cb) => {
          socket.emit(
            "connect-transport",
            { transportId: (recvTransport as any).id, dtlsParameters },
            cb
          );
        });
        recvTransport.on("connectionstatechange", (s) => {
          if (s === "failed" || s === "closed" || s === "disconnected") {
            setError("Transport disconnected");
          }
        });
        recvTransportRef.current = recvTransport;

        await reloadProducers();

        const onNewProducer = async ({
          producerId,
          kind,
          label,
          path,
        }: {
          producerId: string;
          kind: string;
          label?: string;
          path?: string;
        }) => {
          if (
            !mounted ||
            kind !== "video" ||
            consumersRef.current.has(producerId)
          )
            return;

          // nếu server đã emit kèm metadata → dùng luôn, tránh gọi thêm
          if (label || path) {
            infoRef.current.set(producerId, {
              id: producerId,
              kind: "video",
              label,
              path,
            });
          } else {
            const meta = await emitAck("get-producer-info", {
              roomId,
              producerId,
            });
            const info: ProducerInfo | undefined = meta?.info;
            info && infoRef.current.set(producerId, info);
          }

          const info = infoRef.current.get(producerId);
          if (!matchSelection(info)) return;

          await consumeOne(producerId);
          arrangeGrid();
        };

        const onProducerClosed = ({ producerId }: { producerId: string }) => {
          removeTile(producerId);
          arrangeGrid();
          if (consumersRef.current.size === 0)
            setEmptyMsg("Không có luồng video nào phù hợp bộ lọc.");
        };

        socket.on("new-producer", onNewProducer);
        socket.on("producer-closed", onProducerClosed);

        const onReconnect = () => {
          if (reconnecting) return;
          reconnecting = true;
          setTimeout(async () => {
            reconnecting = false;
            await reloadProducers();
          }, 300);
        };
        socket.io.on("reconnect", onReconnect);

        setLoading(false);

        return () => {
          mounted = false;
          socket.off("new-producer", onNewProducer);
          socket.off("producer-closed", onProducerClosed);
          socket.io.off("reconnect", onReconnect);
          consumersRef.current.forEach((c) => {
            try {
              c.close();
            } catch {}
          });
          consumersRef.current.clear();
          recvTransportRef.current?.close();
          recvTransportRef.current = null;
          deviceRef.current = null;
          tilesRef.current.clear();
          infoRef.current.clear();
          if (gridRef.current) gridRef.current.innerHTML = "";
        };
      } catch (e: any) {
        setError(e?.message || String(e));
        setLoading(false);
      }
    };

    start();
  }, [roomId, effectiveSelected.join(","), autoGrid]);

  const reloadProducers = async () => {
    const result = await emitAck("list-producers", { roomId });
    const list: ProducerInfo[] = (result?.producers || []).filter(
      (p: ProducerInfo) => p.kind === "video"
    );

    // dọn tile orphan
    for (const id of Array.from(consumersRef.current.keys())) {
      if (!list.find((p) => p.id === id)) removeTile(id);
    }

    list.forEach((p) => infoRef.current.set(p.id, p));

    let subscribed = 0;
    for (const p of list) {
      if (consumersRef.current.has(p.id)) continue;
      if (!matchSelection(p)) continue;
      await consumeOne(p.id);
      subscribed++;
    }

    arrangeGrid();
    if (!subscribed && consumersRef.current.size === 0) {
      setEmptyMsg(
        effectiveSelected.length
          ? "Không có luồng video trùng khớp bộ lọc."
          : "Chưa có producer nào trong phòng này."
      );
    }
  };

  const consumeOne = async (producerId: string) => {
    const device = deviceRef.current;
    const recvTransport = recvTransportRef.current;
    if (!device || !recvTransport) return;

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

    const info = infoRef.current.get(producerId);
    const cell = document.createElement("div");
    cell.className =
      "cell relative overflow-hidden rounded-2xl shadow bg-neutral-900/60";

    const v = document.createElement("video");
    v.autoplay = true;
    v.playsInline = true;
    (v as any).muted = true;
    v.className = "w-full h-full object-contain bg-black";
    v.srcObject = new MediaStream([consumer.track as MediaStreamTrack]);

    const label = document.createElement("div");
    label.className =
      "absolute left-2 bottom-2 px-2 py-1 text-xs rounded bg-white/75 text-black backdrop-blur-sm";
    label.textContent = info?.label || info?.path || producerId.slice(0, 8);

    const muted = document.createElement("div");
    muted.className =
      "absolute right-2 bottom-2 text-[10px] px-1 py-0.5 rounded bg-white/75 text-black";
    muted.textContent = "muted";

    cell.appendChild(v);
    cell.appendChild(label);
    cell.appendChild(muted);

    tilesRef.current.set(producerId, cell);
    safeAppend(cell);

    consumer.on("transportclose", () => removeTile(producerId));
    consumer.on("trackended", () => removeTile(producerId));

    const tryResume = () => socket.emit("resume", { consumerId: consumer.id });
    if ((v as any).readyState >= 2) tryResume();
    else v.onloadeddata = tryResume;
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

  return (
    <section className="flex flex-col gap-3">
      <div className="toolbar flex items-center gap-2">
        <span className="text-sm">Layout:</span>
        <select
          className="border rounded px-2 py-1"
          value={gridSize}
          onChange={(e) =>
            setGridSize(Number((e.target as HTMLSelectElement).value))
          }
          disabled={autoGrid}
          title={autoGrid ? "Auto grid đang bật" : "Chọn kích thước lưới"}
        >
          <option value={2}>2×2 (tối đa 4)</option>
          <option value={3}>3×3 (tối đa 9)</option>
          <option value={4}>4×4 (tối đa 16)</option>
        </select>
        <button
          onClick={() => reloadProducers()}
          disabled={loading}
          className="px-3 py-1 rounded bg-black text-white disabled:opacity-50"
        >
          {loading ? "Loading…" : "Reload producers"}
        </button>
        {effectiveSelected.length > 0 && (
          <div className="ml-auto text-xs opacity-70">
            Đang lọc: {effectiveSelected.join(", ")}
          </div>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-600 border border-red-200 bg-red-50 px-3 py-2 rounded">
          {error}
        </div>
      )}

      {emptyMsg && !error && (
        <div className="text-sm text-amber-700 border border-amber-200 bg-amber-50 px-3 py-2 rounded">
          {emptyMsg}
        </div>
      )}

      <div
        id="grid"
        ref={gridRef}
        className="grid gap-2 w-full h-[75vh]"
        style={{ gridAutoRows: "1fr" }}
      />
    </section>
  );
}
