import os
import asyncio
import signal
import json
import socketio
import aiohttp
from typing import Optional
from urllib.parse import urlparse, urlunparse

# ========= Config =========
SIGNALING_URL   = os.getenv("SIGNALING_URL", "http://mediasoup-server:3000")   # Socket.IO
ALLOC_API       = os.getenv("ALLOC_API",   "http://mediasoup-server:3100/ingest/create")  # API xin PlainTransport
ROOM_DEFAULT    = os.getenv("ROOM_ID", "lab")

# RTSP/MediaMTX
RTSP_TRANSPORT  = os.getenv("RTSP_TRANSPORT", "tcp")  # "tcp" | "udp"
FFMPEG_BIN      = os.getenv("FFMPEG_BIN", "ffmpeg")
MTX_HOST        = os.getenv("MTX_HOST", "mediamtx")   # service name của MediaMTX (RTSP)
MTX_PORT        = int(os.getenv("MTX_PORT", "8554"))

# H264 -> RTP (copy nếu có thể; nếu camera không tương thích thì chuyển sang baseline)
PREFER_COPY     = False
BITRATE         = os.getenv("BITRATE", "2500k")
GOP_SECONDS     = float(os.getenv("GOP_SECONDS", "2"))

# Ingest (PlainRTP → mediasoup)
INGEST_HOST     = os.getenv("INGEST_HOST", "mediasoup-server")  # hostname đích RTP nếu API trả loopback

# ========= Globals =========
sio = socketio.AsyncClient(reconnection=True, reconnection_attempts=0, reconnection_delay=1)

ff_task: Optional[asyncio.Task] = None
generation = 0
current = {"roomId": None, "id": None, "label": None, "path": None, "rtspUrl": None}
running = True

# ====== Helpers ======
def normalize_source(url: str) -> str:
    """Normalize input URL for either RTSP or HTTP MJPEG.

    For RTSP:
      - Trim trailing punctuation
      - Rewrite localhost hostnames to configured MediaMTX host:port (preserve auth)
    For other schemes (http/https), return as-is (MJPEG cameras often use plain HTTP).
    """
    s = (url or "").strip()
    while s and s[-1] in ".; ":
        s = s[:-1]
    try:
        u = urlparse(s)
        scheme = (u.scheme or '').lower()
        if scheme != "rtsp":
            return s
        host = (u.hostname or "").lower()
        if host in ("localhost", "127.0.0.1", "::1"):
            auth = ""
            if u.username:
                auth = u.username + (f":{u.password}" if u.password else "")
            netloc = f"{MTX_HOST}:{MTX_PORT}"
            if auth:
                netloc = f"{auth}@{netloc}"
            s = urlunparse((u.scheme, netloc, u.path or "", u.params, u.query, u.fragment))
        return s
    except Exception:
        return s

async def http_post_json(url: str, payload: dict, retries: int = 3, delay: float = 0.8) -> dict:
    last = None
    for _ in range(retries):
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    txt = await resp.text()
                    if resp.status >= 400:
                        raise RuntimeError(f"POST {url} -> {resp.status}: {txt[:200]}")
                    return json.loads(txt or "{}")
        except Exception as e:
            last = e
            await asyncio.sleep(delay)
    raise last

def build_ffmpeg_args(source_url: str, ip: str, rtp_port: int, rtcp_port: int, payload_type: int, copy: bool, payload_size: int = 1200):
    """Build ffmpeg command for RTSP or HTTP MJPEG cameras.

    - RTSP: optionally copy H264 to RTP, else transcode.
    - HTTP(S) MJPEG: always transcode to H264 baseline (no copy possible).
    """
    u = urlparse(source_url or '')
    scheme = (u.scheme or '').lower()
    
    rtp_url = f'rtp://{ip}:{rtp_port}?pkt_size={payload_size}&rtcp_port={rtcp_port}'

    # Input chain differs for RTSP vs MJPEG
    if scheme == 'rtsp':
        common_in = [
            FFMPEG_BIN, '-loglevel', 'warning',
            '-rtsp_transport', RTSP_TRANSPORT,
            '-i', source_url,
            '-an',
        ]
        can_copy = copy
    else:
        # MJPEG HTTP stream; force demux as mjpeg if needed
        common_in = [
            FFMPEG_BIN, '-loglevel', 'warning',
            '-i', source_url,
            '-an',
        ]
        can_copy = False  # cannot copy MJPEG into H264 RTP

    if can_copy:
        video_chain = [
            '-c:v', 'copy',
            '-f', 'rtp',
            '-payload_type', str(payload_type),
            rtp_url,
        ]
    else:
        gop = max(1, int(30 * GOP_SECONDS))  # approx 30fps
        video_chain = [
            '-c:v', 'libx264', '-profile:v', 'baseline', '-tune', 'zerolatency',
            '-level', '3.1',
            '-x264-params', f'keyint={gop}:scenecut=0:packetization-mode=1',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-b:v', BITRATE, '-maxrate', BITRATE, '-bufsize', str(int(2*float(BITRATE.rstrip('k')))) + 'k',
            '-pix_fmt', 'yuv420p',
            '-f', 'rtp',
            '-payload_type', str(payload_type),
            rtp_url,
        ]
    return common_in + video_chain

async def spawn_ffmpeg(args):
    return await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

async def ffmpeg_pump(proc: asyncio.subprocess.Process, tag: str):
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            print(f"[ffmpeg:{tag}] {line.decode(errors='ignore').rstrip()}")
    except asyncio.CancelledError:
        pass

async def start_publish(room_id: str, cam_id: str, label: str, path: str, source_url: str):
    """
    1) Gọi /ingest/create xin PlainTransport (server nên dùng comedia+rtcpMux)
    2) Spawn ffmpeg đẩy RTP → mediasoup
    3) Auto-restart nếu ffmpeg chết (cùng thế hệ)
    """
    global ff_task, generation, PREFER_COPY
    tag = cam_id or "cam"
    my_gen = generation

    # 1) Allocate ports
    alloc = await http_post_json(ALLOC_API, {
        "roomId": room_id,
        "label": label,
        "path": path  
    })
    rtp_port = int(alloc["rtpPort"])
    rtcp_port = int(alloc["rtcpPort"])
    payload_type = int(alloc["payloadType"])
    
    ip_from_api = (alloc.get("ip") or "").strip()
    ip = INGEST_HOST if ip_from_api in ("", "127.0.0.1", "::1", "localhost") else ip_from_api

    # 2) Spawn ffmpeg
    args = build_ffmpeg_args(source_url, ip, rtp_port, rtcp_port, payload_type, copy=PREFER_COPY)
    print(f"[publisher] spawn ffmpeg → {ip}:{rtp_port}  copy={PREFER_COPY}  room={room_id} id={cam_id} src={source_url}")
    proc = await spawn_ffmpeg(args)

    async def _runner():
        nonlocal proc
        global PREFER_COPY
        try:
            await ffmpeg_pump(proc, tag)
            ret = await proc.wait()
            print(f"[publisher] ffmpeg exit code={ret}")
            # Auto-restart nếu vẫn là camera hiện tại & cùng thế hệ
            if running and my_gen == generation and current.get("id") == cam_id:
                await asyncio.sleep(1.0)
                print("[publisher] restarting ffmpeg…")
                if PREFER_COPY:
                    PREFER_COPY = False
                    print("[publisher] fallback to transcode (baseline)")
                try:
                    await start_publish(room_id, cam_id, label, path, source_url)
                except Exception as e:
                    print(f"[publisher] restart failed: {e}")
        except asyncio.CancelledError:
            try:
                if proc.returncode is None:
                    proc.send_signal(signal.SIGTERM)
                    try:
                        await asyncio.wait_for(proc.wait(), timeout=3)
                    except asyncio.TimeoutError:
                        proc.kill()
            except Exception:
                pass
        except Exception as e:
            print(f"[publisher] _runner error: {e}")

    ff_task = asyncio.create_task(_runner())

async def stop_publish():
    global ff_task, generation
    if ff_task and not ff_task.cancelled():
        print("[publisher] stopping current ffmpeg…")
        generation += 1  # chặn auto-restart của runner cũ
        ff_task.cancel()
        try:
            await ff_task
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[publisher] stop_publish swallowed error: {e}")
        ff_task = None

# ====== Socket.IO events ======
@sio.event
async def connect():
    print("[publisher] connected to signaling; waiting for start-camera …")
    await sio.emit("join", {"roomId": "_ingest_", "role": "publisher-bot", "id": "rtsp-publisher"})

@sio.on("start-camera")
async def on_start_camera(payload):
    """
    UI/server gửi: { roomId, id, label, path, rtspUrl }
    """
    room_id = payload.get("roomId") or ROOM_DEFAULT
    cam_id  = payload.get("id") or payload.get("cameraId") or "cam-auto"
    label   = payload.get("label")
    path    = payload.get("path")
    # Accept multiple keys for backward compatibility
    raw_url = payload.get("rtspUrl") or payload.get("url") or payload.get("mjpegUrl")
    source  = normalize_source(raw_url)

    if not source:
        print("[publisher] ⚠️ start-camera thiếu source URL")
        return

    current.update(roomId=room_id, id=cam_id, label=label, path=path, rtspUrl=source)
    await stop_publish()
    print(f"🟢 start-camera room={room_id} id={cam_id} label={label} path={path} url={source}")
    try:
        await start_publish(room_id, cam_id, label, path, source)
    except Exception as e:
        print(f"[publisher] start_publish failed: {e}")

@sio.on("stop-camera")
async def on_stop_camera(payload):
    target_id = payload.get("id") or payload.get("cameraId")
    if target_id is None or target_id == current.get("id"):
        print(f"🔴 stop-camera id={current.get('id')}")
        await stop_publish()
        current.update(roomId=None, id=None, label=None, path=None, rtspUrl=None)

async def heartbeat_task():
    while True:
        try:
            await sio.emit("publisher-keepalive", {"roomId": ROOM_DEFAULT, "id": "rtsp-publisher"})
        except Exception:
            pass
        await asyncio.sleep(10)

# ====== Main ======
async def main():
    await sio.connect(SIGNALING_URL)
    asyncio.create_task(heartbeat_task())
    await sio.wait()

def _shutdown():
    global running
    running = False

if __name__ == "__main__":
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown)
        except NotImplementedError:
            pass
    try:
        loop.run_until_complete(main())
    finally:
        loop.run_until_complete(stop_publish())
