import cors from "cors";
import * as dotenv from "dotenv";
import express from "express";
import http from "http";
import mediasoup from "mediasoup";
import { MongoClient, ServerApiVersion } from "mongodb";
import { Server } from "socket.io";
dotenv.config({ path: [".env.local",".env"] });

const port = process.env.PORT || 5001;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 25000,
  pingTimeout: 60000,
});
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

let worker;

app.use(cors());
app.use(express.json());

async function connectDBAndWorker() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");
    worker = await mediasoup.createWorker({
      logLevel: "warn",
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
    });
    console.log("✅ Mediasoup worker created", worker.pid);
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}
connectDBAndWorker().catch((err) => console.error(err));

const db = client.db("collMate");
const roomCollection = db.collection("rooms");

const rooms = new Map();

io.on("connection", (socket) => {
  console.log("🔌 Connected:", socket.id);

  socket.on("join-room", async ({ roomName, email }, callback) => {
    if (!roomName || !email) {
      callback({
        status: "error",
        message: "Room name or email not provided.",
      });
      return;
    }

    try {
      const roomsFromDb = await roomCollection.find({}).toArray();
      const currentRoom = roomsFromDb.find(
        (data) => data.roomName === roomName
      );

      if (!currentRoom) {
        callback({ status: "error", message: "Room does not exist." });
        return;
      }

      socket.join(roomName);
      callback({ status: "success", message: `Joined room ${roomName}` });

      if (!rooms.has(roomName)) {
        const router = await worker.createRouter({ mediaCodecs });
        rooms.set(roomName, { router, participants: [] });
      }

      const room = rooms.get(roomName);

      if (!room.participants.find((p) => p.user === email)) {
        room.participants.push({
          id: socket.id,
          user: email,
          transports: [],
          producers: [],
          consumers: [],
        });
      }

      // Send router RTP capabilities
      socket.emit("routerCapabilities", {
        rtpCapabilities: room.router.rtpCapabilities,
      });

      // Create send transport
      const sendTransport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: null }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
      });

      sendTransport.on("dtlsstatechange", (state) => {
        console.log("🧬 SendServer DTLS state changed:", state);
      });

      // Create receive transport
      const rcvTransport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: null }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
      });

      rcvTransport.on("dtlsstatechange", (state) => {
        console.log("🧬 RcvServer DTLS state changed:", state);
      });

      const participant = room.participants.find((p) => p.user === email);
      if (!participant) {
        callback({ status: "error", message: "Participant Not Found" });
        return;
      }
      // Store transport info in array
      participant.transports.push({
        id: sendTransport.id,
        direction: "send",
        transport: sendTransport,
      });

      participant.transports.push({
        id: rcvTransport.id,
        direction: "recv",
        transport: rcvTransport,
      });

      // Emit transport info to client
      socket.emit("createSendTransport", {
        id: sendTransport.id,
        iceParameters: sendTransport.iceParameters,
        iceCandidates: sendTransport.iceCandidates,
        dtlsParameters: sendTransport.dtlsParameters,
      });

      socket.emit("createRcvTransport", {
        id: rcvTransport.id,
        iceParameters: rcvTransport.iceParameters,
        iceCandidates: rcvTransport.iceCandidates,
        dtlsParameters: rcvTransport.dtlsParameters,
      });

      // Notify others
      socket.to(roomName).emit("user-joined", email);

      // Notify about existing producers
      room.participants.forEach((p) => {
        if (p.user !== email) {
          (p.producers || []).forEach((producer) => {
            socket.emit("newProducer", {
              producerId: producer.id,
              user: p.user,
              kind: producer.kind,
            });
          });
        }
      });
    } catch (err) {
      console.error("Join error:", err);
      callback({ status: "error", message: "Internal Server Error" });
    }
  });

  socket.on(
    "connectTransport",
    async (
      { transportId, dtlsParameters, room: roomName, email },
      callback
    ) => {
      try {
        const room = rooms.get(roomName);
        if (!room) return;
        const participant = room.participants.find((p) => p.user === email);

        const transport = participant.transports.find(
          (t) => t.id === transportId
        );

        if (!transport) {
          callback({ error: "Transport not found" });
          return;
        }

        await transport.transport.connect({ dtlsParameters });

        console.log(
          `Transport ${transportId} connected, new state:`,
          transport.dtlsState
        );

        callback({ success: true });
      } catch (err) {
        if (err.message.includes("connect() already called")) {
          console.warn("🟡 Transport already connected, ignoring.");
          callback({ success: true });
        } else {
          console.error("❌ Transport connect failed:", err);
          callback({ error: err.message });
        }
      }
    }
  );

  socket.on(
    "produce",
    async (
      { transportId, kind, rtpParameters, room: roomName, email },
      callback
    ) => {
      try {
        const room = rooms.get(roomName);
        if (!room) return;
        const participant = room.participants.find((p) => p.user === email);
        if (!participant) {
          callback({ error: "Participant not found" });
          return;
        }
        const transport = participant.transports.find(
          (t) => t.id === transportId
        );

        if (!transport) {
          callback({ error: "Transport not found" });
          return;
        }
        // Produce media
        const producer = await transport.transport.produce({
          kind,
          rtpParameters,
        });
        await producer.resume();

        // Inform others in the room
        socket.to(roomName).emit("newProducer", {
          producerId: producer.id,
          user: email,
          kind: producer.kind,
        });

        // Callback with success
        callback({ id: producer.id });

        // Store producer metadata only
        participant.producers.push({
          id: producer.id,
          producer,
        });
      } catch (err) {
        console.error("❌ Produce error:", err);
        callback({ error: err.message });
      }
    }
  );

  socket.on(
    "consume",
    async (
      { producerId, rtpCapabilities, room: roomName, email },
      callback
    ) => {
      const room = rooms.get(roomName);
      if (!room) return callback({ error: "Room not found" });

      const participant = room.participants.find((p) => p.user === email);
      if (!participant) return callback({ error: "Participant not found" });

      const producer = room.participants
        .flatMap((p) => p.producers)
        .find((p) => p.id === producerId);
      if (!producer) return callback({ error: "Producer not found" });

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: "Cannot consume this producer" });
      }

      const recvTransport = participant.transports.find(
        (t) => t.direction === "recv"
      );

      const consumer = await recvTransport.transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      participant.consumers.push({
        id: consumer.id,
        consumer,
      });

      await consumer.resume();
      console.log("transport State newConsumer:", recvTransport.id);
      console.log(
        "🚀 Created consumer:",
        consumer.kind,
        "paused?",
        consumer.paused
      );

      callback({
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    }
  );

  socket.on(
    "closeProducer",
    async ({ producerId, room: roomName, email }, callback) => {
      try {
        const room = rooms.get(roomName);
        if (!room) return callback({ error: "Room not found" });

        const participant = room.participants.find((p) => p.user === email);
        if (!participant) return callback({ error: "Participant not found" });

        const producer = room.participants
          .flatMap((p) => p.producers)
          .find((p) => p.id === producerId);
        if (!producer) return callback({ error: "Producer not found" });

        if (producer) {
          await producer.producer.close();
          console.log(`Producer ${producerId} closed by ${email}`);

          // Notify other participants
          socket.to(roomName).emit("producer-closed", {
            producerId,
            user: email,
          });

          callback({ success: true });
        } else {
          callback({ error: "Producer not found" });
        }
      } catch (error) {
        console.error("Error closing producer:", error);
        callback({ error: error.message });
      }
    }
  );

  socket.on("coding", (newCode, room, email) => {
    socket.to(room).emit("editingOnCode", email, newCode);
  });

  socket.on("disconnect", (reason) => {
    console.log("❌ Disconnected:", socket.id, reason);

    for (const [roomName, room] of rooms) {
      const idx = room.participants.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        // close media objects
        room.participants[idx].transports.forEach((t) => t.transport.close());
        room.participants[idx].producers.forEach((p) => p.producer.close());
        room.participants[idx].consumers.forEach((c) => c.consumer.close());

        const user = room.participants.find((p) => p.id === socket.id);
        room.participants.splice(idx, 1);
        socket.to(roomName).emit("user-left", user.user);
        console.log(`🧹 Removed ${user.user} from ${roomName}`);
      }
    }
  });
});

server.listen(port, () => {
  console.log("✅ Server listening on http://localhost:5000");
});
