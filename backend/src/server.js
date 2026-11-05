import http from "node:http";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT) || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

const server = http.createServer((req, res) => {
  // Baseline security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  socket.on("hello", (payload) => {
    console.log(`[Socket] Received 'hello' from ${socket.id}:`, payload);
    socket.emit("hello-reply", {
      message: "Hello from Shuup backend!",
      received: payload,
      timestamp: Date.now()
    });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
  });
});

server.listen(PORT, () => {
  console.log(`Shuup backend running on port ${PORT}`);
  console.log(`Allowed CORS origin: ${CORS_ORIGIN}`);
});

