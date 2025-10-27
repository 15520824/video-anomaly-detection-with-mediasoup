import { io } from "socket.io-client";

// dùng same-origin -> Nginx/Caddy sẽ proxy tới server:3000
export const socket = io({
  path: "/socket.io",
  transports: ["websocket"],
  withCredentials: true,
});
