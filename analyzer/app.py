import asyncio, os, socketio, cv2, numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from aiortc.contrib.media import MediaBlackhole


SIGNALING_URL = os.getenv("SIGNALING_URL", "http://server:3000")
ROOM_ID = os.getenv("ROOM_ID", "lab")
BOT_ID = os.getenv("AI_BOT_ID", "analyzer-bot")


sio = socketio.AsyncClient()
pc = RTCPeerConnection({
    "iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}],
    "iceTransportPolicy": "all",
    "bundlePolicy": "max-bundle",
    "rtcpMuxPolicy": "require",
    "icecandidatePoolSize": 0
})
blackhole = MediaBlackhole()


face = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')


class VideoSink(MediaStreamTrack): # chỉ để bắt khung ảnh
    kind = "video"
    def __init__(self, track):
        super().__init__()
        self.track = track
    async def recv(self):
        frame = await self.track.recv()
        img = frame.to_ndarray(format="bgr24")
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = face.detectMultiScale(gray, 1.2, 5)
        if len(faces):
            print(f"[AI] Faces: {len(faces)}")
        return frame


@sio.event
async def connect():
    print("[AI] connected to signaling")
    await sio.emit('join', {"roomId": ROOM_ID, "role": "bot"})


@sio.on('router-rtp-capabilities')
async def on_caps(caps):
# tạo consumer transport
    await sio.emit('create-transport', {"roomId": ROOM_ID}, callback=on_transport_created)


async def on_transport_created(data):
# kết nối DTLS
    params = data['dtlsParameters']
    await sio.emit('connect-transport', {"transportId": data['id'], "dtlsParameters": params})


# chờ có producer mới trong phòng
@sio.on('new-producer')
async def on_new_producer(payload):
    await consume(data['id'], payload['producerId'])


async def consume(transport_id, producer_id):
# yêu cầu server tạo consumer
    from aiortc.rtcrtpparameters import RTCRtpCapabilities
    caps = RTCRtpCapabilities.from_json({'codecs': [], 'headerExtensions': []})
    def _cb(res):
        pass
    await sio.emit('consume', {
        'roomId': ROOM_ID,
        'transportId': transport_id,
        'producerId': producer_id,
        'rtpCapabilities': caps.to_json()
    }, callback=_cb)

async def main():
    await sio.connect(SIGNALING_URL)
    await sio.wait()

if __name__ == '__main__':
    asyncio.run(main())