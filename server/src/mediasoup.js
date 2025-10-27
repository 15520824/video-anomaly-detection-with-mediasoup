import mediasoup from "mediasoup";
import cfg from "../config.js";

export async function createWorker() {
  const worker = await mediasoup.createWorker({
    rtcMinPort: cfg.minPort,
    rtcMaxPort: cfg.maxPort,
    logLevel: "warn",
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
  });
  worker.on("died", () => process.exit(1));
  const router = await worker.createRouter({
    mediaCodecs: cfg.rtc.mediaCodecs,
  });
  return { worker, router };
}

export async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: cfg.listenIp, announcedIp: cfg.announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });
  return transport;
}
