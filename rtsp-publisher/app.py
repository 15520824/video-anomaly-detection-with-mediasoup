import os, asyncio, numpy as np, socketio
from aiortc import RTCPeerConnection, MediaStreamTrack, RTCSessionDescription
from av import VideoFrame
import av

SIGNALING_URL   = os.getenv("SIGNALING_URL", "http://localhost:3000")
ROOM_ID         = os.getenv("ROOM_ID", "lab")
CAMERA_ID       = os.getenv("CAMERA_ID", "cam-01")
RTSP_URL        = os.getenv("RTSP_URL")
RTSP_TRANSPORT  = os.getenv("RTSP_TRANSPORT", "tcp")     # tcp|udp
RTSP_TIMEOUT_MS = int(os.getenv("RTSP_TIMEOUT_MS", "5000"))

sio = socketio.AsyncClient()
pc  = RTCPeerConnection()

class RTSPVideoTrack(MediaStreamTrack):
    kind = "video"
    def __init__(self, url):
        super().__init__()
        self.url = url
        self.container = None
        self.stream = None

    def _open(self):
        self.container = av.open(
            self.url,
            options={
                "rtsp_transport": RTSP_TRANSPORT,
                "stimeout": str(RTSP_TIMEOUT_MS * 1000),
                "rw_timeout": str(RTSP_TIMEOUT_MS * 1000),
            }
        )
        self.stream = next(s for s in self.container.streams if s.type == "video")
        self.stream.thread_type = "AUTO"

    async def recv(self):
        if self.container is None:
            self._open()
        for _ in range(3):
            try:
                frame = next(self.container.decode(self.stream))
                if frame.format.name != "rgb24":
                    frame = frame.reformat(format="rgb24")
                return frame
            except StopIteration:
                await asyncio.sleep(0.02)
            except Exception:
                try:
                    if self.container:
                        self.container.close()
                finally:
                    self.container = None
                    await asyncio.sleep(1)
                    self._open()
        # fallback: frame đen
        import numpy as np
        black = np.zeros((480, 640, 3), dtype=np.uint8)
        return VideoFrame.from_ndarray(black, format="rgb24")

# ----- Socket.IO signaling -----

@sio.event
async def connect():
    print("[publisher] connected to signaling")
    await sio.emit("join", {"roomId": ROOM_ID, "role": "publisher", "id": CAMERA_ID})
    await start_webrtc()

async def start_webrtc():
    # add RTSP video
    track = RTSPVideoTrack(RTSP_URL)
    pc.addTrack(track)

    # optional: prefer UDP ICE; khi cần TURN, server nên trả ICE phù hợp
    @pc.on("iceconnectionstatechange")
    async def on_state_change():
        print("[publisher] ICE:", pc.iceConnectionState)

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    # gửi SDP offer lên server -> chờ SDP answer
    fut = asyncio.get_event_loop().create_future()

    @sio.on("bot-answer")
    async def on_bot_answer(payload):
        if payload.get("roomId") == ROOM_ID and payload.get("id") == CAMERA_ID:
            if not fut.done():
                fut.set_result(payload["sdp"])

    await sio.emit("bot-offer", {
        "roomId": ROOM_ID,
        "id": CAMERA_ID,
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    })

    answer_sdp = await fut
    await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))
    print("[publisher] set remote answer OK")

async def main():
    await sio.connect(SIGNALING_URL)
    await sio.wait()

if __name__ == "__main__":
    asyncio.run(main())
