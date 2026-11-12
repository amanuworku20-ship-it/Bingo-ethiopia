const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const io = new Server(server, {
  cors: { origin: "*" }
});

const rooms = new Map();

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function publicState(room) {
  return {
    roomId: room.roomId,
    hostName: room.hostName,
    playerCount: room.players.size,
    mode: room.mode,
    gameStarted: room.gameStarted,
    autoCall: room.autoCall,
    called: room.called,
    lastNumber: room.called.length
      ? room.called[room.called.length - 1]
      : null
  };
}

function broadcastState(room) {
  io.to(room.roomId).emit("gameState", publicState(room));
}

function callNextNumber(room) {
  if (!room.gameStarted || room.numbers.length === 0) {
    if (room.gameStarted) {
      room.gameStarted = false;
      room.autoCall = false;
      clearInterval(room.timer);
      room.timer = null;
      io.to(room.roomId).emit("gameEnded", {
        message: "All numbers have been called!"
      });
      broadcastState(room);
    }
    return;
  }

  const number = room.numbers.pop();
  room.called.push(number);

  io.to(room.roomId).emit("numberCalled", {
    number,
    called: room.called,
    mode: room.mode
  });

  broadcastState(room);
}

function stopAutoCall(room) {
  if (room.timer !== null) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("joinRoom", (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    const playerName = String(data.playerName || "Player")
      .trim()
      .slice(0, 30);

    if (!roomId || roomId.length > 30 || !playerName) {
      socket.emit("joinError", "Invalid room ID or player name.");
      return;
    }

    if (socket.data.roomId) {
      socket.emit("joinError", "You are already in a room.");
      return;
    }

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        roomId,
        hostId: socket.id,
        hostName: playerName,
        players: new Map(),
        usedCards: new Set(),
        mode: 75,
        numbers: [],
        called: [],
        gameStarted: false,
        autoCall: false,
        timer: null
      });
    }

    const room = rooms.get(roomId);

    if (room.gameStarted) {
      socket.emit("joinError", "Please join after the current game ends.");
      return;
    }

    const requestedCards = Array.isArray(data.cardNumbers)
      ? data.cardNumbers
      : [data.cardNumber || 1];

    const cardNumbers = [...new Set(
      requestedCards.map(Number)
    )];

    if (
      cardNumbers.length < 1 ||
      cardNumbers.length > 3 ||
      cardNumbers.some(n =>
        !Number.isInteger(n) || n < 1 || n > 600
      )
    ) {
      socket.emit("joinError", "Choose 1 to 3 valid card numbers (1-600).");
      return;
    }

    if (cardNumbers.some(n => room.usedCards.has(n))) {
      socket.emit("joinError", "One or more selected cards are already taken.");
      return;
    }

    cardNumbers.forEach(n => room.usedCards.add(n));

    room.players.set(socket.id, {
      playerName,
      cardNumbers
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;
    socket.data.cardNumbers = cardNumbers;

    socket.emit("joinedRoom", {
      roomId,
      playerName,
      playerCount: room.players.size,
      cardNumbers,
      cardNumber: cardNumbers[0],
      isHost: room.hostId === socket.id,
      gameState: publicState(room)
    });

    io.to(roomId).emit("roomUpdate", {
      roomId,
      playerCount: room.players.size,
      hostName: room.hostName
    });

    socket.to(roomId).emit("playerJoined", {
      playerName,
      cardNumbers
    });

    console.log(
      playerName + " joined room " + roomId +
      " with Cards " + cardNumbers.join(", ")
    );

    broadcastState(room);
  });

  socket.on("startGameRequest", (data = {}) => {
    const room = rooms.get(socket.data.roomId);

    if (!room || room.hostId !== socket.id) {
      socket.emit("gameError", "Only the room host can start the game.");
      return;
    }

    const mode = Number(data.mode);

    if (mode !== 75 && mode !== 90) {
      socket.emit("gameError", "Choose 75-ball or 90-ball.");
      return;
    }

    stopAutoCall(room);

    room.mode = mode;
    room.numbers = [];

    for (let n = 1; n <= mode; n++) {
      room.numbers.push(n);
    }

    shuffle(room.numbers);
    room.called = [];
    room.gameStarted = true;
    room.autoCall = false;

    io.to(room.roomId).emit("gameStarted", {
      mode: room.mode,
      called: []
    });

    callNextNumber(room);
  });

  socket.on("nextNumberRequest", () => {
    const room = rooms.get(socket.data.roomId);

    if (!room || room.hostId !== socket.id) {
      socket.emit("gameError", "Only the host can call the next number.");
      return;
    }

    if (!room.gameStarted || room.autoCall) {
      socket.emit("gameError", "Turn off AUTO CALL before using NEXT NUMBER.");
      return;
    }

    callNextNumber(room);
  });

  socket.on("autoCallRequest", (data = {}) => {
    const room = rooms.get(socket.data.roomId);

    if (!room || room.hostId !== socket.id) {
      socket.emit("gameError", "Only the host can control AUTO CALL.");
      return;
    }

    if (!room.gameStarted) {
      socket.emit("gameError", "Start the game first.");
      return;
    }

    room.autoCall = Boolean(data.enabled);
    stopAutoCall(room);

    if (room.autoCall) {
      room.timer = setInterval(() => {
        callNextNumber(room);
      }, 5000);
    }

    io.to(room.roomId).emit("autoCallChanged", {
      enabled: room.autoCall
    });

    broadcastState(room);
  });

  socket.on("endGameRequest", () => {
    const room = rooms.get(socket.data.roomId);

    if (!room || room.hostId !== socket.id) {
      socket.emit("gameError", "Only the host can end the game.");
      return;
    }

    stopAutoCall(room);
    room.gameStarted = false;
    room.autoCall = false;

    io.to(room.roomId).emit("gameEnded", {
      message: "The host ended the game."
    });

    broadcastState(room);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;

    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const player = room.players.get(socket.id);

      if (player) {
        room.players.delete(socket.id);
          (player.cardNumbers || [player.cardNumber]).forEach(cardNumber => {
            room.usedCards.delete(cardNumber);
          });

        socket.to(roomId).emit("playerLeft", {
          playerName: player.playerName
        });
      }

      if (room.hostId === socket.id && room.players.size > 0) {
        const nextHost = room.players.entries().next().value;
        room.hostId = nextHost[0];
        room.hostName = nextHost[1].playerName;

        io.to(roomId).emit("hostChanged", {
          hostName: room.hostName
        });
      }

      if (room.players.size === 0) {
        stopAutoCall(room);
        rooms.delete(roomId);
      } else {
        io.to(roomId).emit("roomUpdate", {
          roomId,
          playerCount: room.players.size,
          hostName: room.hostName
        });

        broadcastState(room);
      }
    }

    console.log("Disconnected:", socket.id);
  });
});

app.get("/health", (req, res) => {
  res.send("BINGO ETHIOPIA MULTIPLAYER SERVER IS RUNNING!");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("BINGO ETHIOPIA MULTIPLAYER SERVER running on port " + PORT);
});
