const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room: ${roomId}`);
    socket.to(roomId).emit('peer-joined', socket.id);

    socket.on('signal', (data) => {
      socket.to(roomId).emit('signal', {
        sender: socket.id,
        signal: data.signal
      });
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      socket.to(roomId).emit('peer-disconnected');
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signaling server running on http://localhost:${PORT}`));
