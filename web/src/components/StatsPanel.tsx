// web/src/pages/CameraManager.tsx
import React, { useEffect, useMemo, useState } from "react";

type PathItem = {
  name: string;
  // tuỳ MediaMTX API trả về, để any cho linh hoạt
  [k: string]: any;
};

const API_BASE = ""; // same-origin. Nếu cần: "https://your-domain"

const isRtsp = (s: string) => /^rtsp(s)?:\/\//i.test(s);
const niceErr = (e: unknown) =>
  e instanceof Error
    ? e.message
    : typeof e === "string"
    ? e
    : "unexpected error";

export default function StatsPanel() {
  const [name, setName] = useState("");
  const [rtspUrl, setRtspUrl] = useState("");
  const [onDemand, setOnDemand] = useState(true);
  const [forceTCP, setForceTCP] = useState(true);
  const [paths, setPaths] = useState<PathItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{
    type: "ok" | "err";
    msg: string;
  } | null>(null);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return paths;
    return paths.filter((p) => p.name?.toLowerCase().includes(q));
  }, [paths, filter]);

  const hostLabel = useMemo(() => {
    // Dùng host hiện tại để gợi ý URL phát: rtsp://<host>:8554/<name>
    const h = window.location.hostname || "localhost";
    return `${h}:8554`;
  }, []);

  async function fetchPaths() {
    try {
      const r = await fetch(`${API_BASE}/ingest/cameras`);
      const j = await r.json();
      // MediaMTX /v3/paths/list trả {items:[{name,...}]}
      const list = Array.isArray(j?.items)
        ? j.items
        : Array.isArray(j)
        ? j
        : [];
      setPaths(list);
    } catch (e) {
      setNotice({
        type: "err",
        msg: `Không tải được danh sách: ${niceErr(e)}`,
      });
    }
  }

  useEffect(() => {
    fetchPaths();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);

    if (!name.trim())
      return setNotice({ type: "err", msg: "Nhập tên path (ví dụ: cam1)" });
    if (!rtspUrl.trim() || !isRtsp(rtspUrl))
      return setNotice({
        type: "err",
        msg: "URL phải bắt đầu bằng rtsp:// hoặc rtsps://",
      });

    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/ingest/cameras`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          rtspUrl: rtspUrl.trim(),
          onDemand,
          forceTCP,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Add failed");

      setNotice({
        type: "ok",
        msg: `Đã thêm "${name}". RTSP: rtsp://${hostLabel}/${name}`,
      });
      setName("");
      setRtspUrl("");
      fetchPaths();
    } catch (e) {
      setNotice({ type: "err", msg: niceErr(e) });
    } finally {
      setLoading(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => setNotice({ type: "ok", msg: "Đã copy vào clipboard" }),
      () => setNotice({ type: "err", msg: "Copy thất bại" })
    );
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.h1}>IP Camera Manager</h1>

      <form onSubmit={handleAdd} style={styles.card}>
        <div style={styles.row}>
          <label style={styles.label}>Tên path</label>
          <input
            style={styles.input}
            placeholder="cam1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div style={styles.row}>
          <label style={styles.label}>RTSP URL</label>
          <input
            style={styles.input}
            placeholder="rtsp://user:pass@192.168.1.50:554/Streaming/Channels/101"
            value={rtspUrl}
            onChange={(e) => setRtspUrl(e.target.value)}
            required
          />
        </div>

        <div style={{ ...styles.row, ...styles.rowInline }}>
          <label style={styles.checkWrap}>
            <input
              type="checkbox"
              checked={onDemand}
              onChange={(e) => setOnDemand(e.target.checked)}
            />
            &nbsp;Chỉ kéo khi có người xem (On-Demand)
          </label>
          <label style={styles.checkWrap}>
            <input
              type="checkbox"
              checked={forceTCP}
              onChange={(e) => setForceTCP(e.target.checked)}
            />
            &nbsp;Ép TCP (ổn định hơn)
          </label>
        </div>

        <div style={styles.row}>
          <button type="submit" disabled={loading} style={styles.btnPrimary}>
            {loading ? "Đang thêm…" : "Thêm camera"}
          </button>
          <button type="button" onClick={fetchPaths} style={styles.btnGhost}>
            Reload danh sách
          </button>
        </div>

        <div style={styles.hint}>
          Sau khi thêm, bạn có thể xem bằng VLC:&nbsp;
          <code>
            rtsp://{hostLabel}/{name || "cam1"}
          </code>
        </div>

        {notice && (
          <div
            style={{
              ...styles.notice,
              background: notice.type === "ok" ? "#e9fbe9" : "#fdeaea",
              color: notice.type === "ok" ? "#0c6c27" : "#a01212",
              borderColor: notice.type === "ok" ? "#b8f0c2" : "#f5bcbc",
            }}
          >
            {notice.msg}
          </div>
        )}
      </form>

      <div style={styles.card}>
        <div style={{ ...styles.row, ...styles.rowInline }}>
          <h2 style={styles.h2}>Danh sách streams</h2>
          <input
            style={{ ...styles.input, maxWidth: 280 }}
            placeholder="Tìm theo tên…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {filtered.length === 0 ? (
          <div style={styles.empty}>Chưa có stream nào.</div>
        ) : (
          <div style={styles.list}>
            {filtered.map((p) => {
              const playUrl = `rtsp://${hostLabel}/${p.name}`;
              return (
                <div key={p.name} style={styles.item}>
                  <div style={{ flex: 1 }}>
                    <div style={styles.itemTitle}>{p.name}</div>
                    <div style={styles.itemSub}>
                      RTSP: <code>{playUrl}</code>
                    </div>
                  </div>
                  <div style={styles.actions}>
                    <button
                      style={styles.btnGhost}
                      onClick={() => copy(playUrl)}
                    >
                      Copy URL
                    </button>
                    {/* nếu bạn có route xem: /viewer/:roomId?path=name */}
                    <a
                      href={`/viewer/${encodeURIComponent(p.name)}`}
                      style={styles.btnLink}
                    >
                      Test trong viewer
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 880,
    margin: "32px auto",
    padding: "0 16px",
    fontFamily:
      "Inter, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
  },
  h1: { fontSize: 24, fontWeight: 700, margin: "8px 0 16px" },
  h2: { fontSize: 18, fontWeight: 700, margin: 0 },
  card: {
    background: "#fff",
    border: "1px solid #eaeaea",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
  },
  row: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  rowInline: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  label: { fontSize: 13, color: "#444" },
  input: {
    padding: "10px 12px",
    border: "1px solid #dcdcdc",
    borderRadius: 10,
    outline: "none",
  },
  btnPrimary: {
    appearance: "none",
    border: 0,
    background: "#111",
    color: "#fff",
    padding: "10px 14px",
    borderRadius: 10,
    cursor: "pointer",
    minWidth: 140,
  },
  btnGhost: {
    appearance: "none",
    border: "1px solid #ddd",
    background: "#fff",
    color: "#111",
    padding: "10px 14px",
    borderRadius: 10,
    cursor: "pointer",
    marginLeft: 8,
  },
  btnLink: {
    textDecoration: "none",
    border: "1px solid #ddd",
    padding: "8px 12px",
    borderRadius: 10,
    color: "#111",
    display: "inline-block",
  },
  hint: { fontSize: 12, color: "#666", marginTop: 4 },
  notice: {
    marginTop: 10,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid",
    fontSize: 13,
  },
  list: { display: "flex", flexDirection: "column", gap: 10, marginTop: 8 },
  item: {
    border: "1px solid #eee",
    borderRadius: 10,
    padding: 12,
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  itemTitle: { fontWeight: 700, marginBottom: 4 },
  itemSub: { fontSize: 12, color: "#666" },
  actions: { display: "flex", alignItems: "center", gap: 8 },
  checkWrap: { display: "flex", alignItems: "center", cursor: "pointer" },
  empty: { color: "#666", fontSize: 14 },
};
