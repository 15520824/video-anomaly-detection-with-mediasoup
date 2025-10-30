export default {
  listenIp: process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0",
  announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP, // public IP
  minPort: parseInt(process.env.MEDIASOUP_MIN_PORT || "40000"),
  maxPort: parseInt(process.env.MEDIASOUP_MAX_PORT || "40020"),
  webPort: parseInt(process.env.PORT || "3000"),
  rtc: {
    // codec mặc định phổ biến trên trình duyệt
    mediaCodecs: [
      { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
      {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
          "packetization-mode": 1,
          "profile-level-id": "42e01f",
          "level-asymmetry-allowed": 1,
        },
      },
      { kind: "video", mimeType: "video/VP8", clockRate: 90000 },
    ],
  },
};
