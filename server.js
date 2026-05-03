// GenChess Server — Railway-ready Node.js + Socket.io
// Deploy: push to Railway, set PORT env var (Railway sets it automatically)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://genlayerchess.netlify.app', 'http://localhost'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const PORT = process.env.PORT || 3001;

// ─── In-memory state ───────────────────────────────────────────────────────
const onlinePlayers = new Map();   // socketId → { userId, username, role, rating }
const gameRooms     = new Map();   // gameId   → GameRoom
const tournaments   = new Map();   // tourneyId → Tournament
const challenges    = new Map();   // challengeId → { from, to, timeControl }

// ─── Helpers ──────────────────────────────────────────────────────────────
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function broadcastLobby() {
  const players = Array.from(onlinePlayers.values()).map(p => ({
    userId: p.userId,
    username: p.username,
    role: p.role,
    rating: p.rating,
    status: p.status
  }));
  io.emit('lobby:players', players);
}

// ─── Game Room ────────────────────────────────────────────────────────────
class GameRoom {
  constructor(gameId, whitePlayer, blackPlayer, timeControl) {
    this.gameId = gameId;
    this.chess = new Chess();
    this.white = whitePlayer;   // { socketId, userId, username, rating }
    this.black = blackPlayer;
    this.timeControl = timeControl; // { minutes: 3, increment: 0 }
    this.clocks = {
      white: timeControl.minutes * 60 * 1000,
      black: timeControl.minutes * 60 * 1000
    };
    this.lastMoveTime = null;
    this.activeColor = 'white';
    this.clockInterval = null;
    this.status = 'playing'; // playing | checkmate | draw | resignation | timeout | aborted
    this.winner = null;
    this.pgn = '';
    this.moveHistory = [];
    this.chat = [];
    this.tournamentId = null;
  }

  startClock() {
    this.lastMoveTime = Date.now();
    this.clockInterval = setInterval(() => this._tickClock(), 100);
  }

  _tickClock() {
    if (this.status !== 'playing') {
      clearInterval(this.clockInterval);
      return;
    }
    const elapsed = Date.now() - this.lastMoveTime;
    const color = this.activeColor;
    const remaining = this.clocks[color] - elapsed;

    if (remaining <= 0) {
      clearInterval(this.clockInterval);
      this.clocks[color] = 0;
      this.status = 'timeout';
      this.winner = color === 'white' ? 'black' : 'white';
      this._broadcastGameOver('timeout');
    } else {
      io.to(this.gameId).emit('game:clocks', {
        white: color === 'white' ? remaining : this.clocks.white,
        black: color === 'black' ? remaining : this.clocks.black
      });
    }
  }

  makeMove(move) {
    const elapsed = Date.now() - this.lastMoveTime;
    this.clocks[this.activeColor] = Math.max(0, this.clocks[this.activeColor] - elapsed);
    // Apply increment
    this.clocks[this.activeColor] += this.timeControl.increment * 1000;
    this.lastMoveTime = Date.now();

    const result = this.chess.move(move);
    if (!result) return null;

    this.moveHistory.push({
      san: result.san,
      from: result.from,
      to: result.to,
      color: result.color,
      flags: result.flags
    });

    this.activeColor = this.chess.turn() === 'w' ? 'white' : 'black';

    // Check end conditions
    if (this.chess.isCheckmate()) {
      this.status = 'checkmate';
      this.winner = this.activeColor === 'white' ? 'black' : 'white';
      clearInterval(this.clockInterval);
      this._broadcastGameOver('checkmate');
    } else if (this.chess.isDraw()) {
      this.status = 'draw';
      clearInterval(this.clockInterval);
      this._broadcastGameOver('draw');
    }

    return result;
  }

  resign(color) {
    clearInterval(this.clockInterval);
    this.status = 'resignation';
    this.winner = color === 'white' ? 'black' : 'white';
    this._broadcastGameOver('resignation');
  }

  offerDraw(color) {
    const opponent = color === 'white' ? this.black : this.white;
    io.to(opponent.socketId).emit('game:drawOffer', { from: color });
  }

  acceptDraw() {
    clearInterval(this.clockInterval);
    this.status = 'draw';
    this.winner = null;
    this._broadcastGameOver('draw');
  }

  _broadcastGameOver(reason) {
    const payload = {
      status: this.status,
      winner: this.winner,
      reason,
      pgn: this.chess.pgn(),
      clocks: this.clocks
    };
    io.to(this.gameId).emit('game:over', payload);
    // Update player statuses
    [this.white, this.black].forEach(p => {
      const player = onlinePlayers.get(p.socketId);
      if (player) player.status = 'online';
    });
    broadcastLobby();
  }

  getPGN() {
    return this.chess.pgn();
  }
}

// ─── Swiss Tournament ─────────────────────────────────────────────────────
class Tournament {
  constructor(id, name, timeControl, rounds, createdBy) {
    this.id = id;
    this.name = name;
    this.timeControl = timeControl;
    this.maxRounds = rounds;
    this.currentRound = 0;
    this.createdBy = createdBy;
    this.status = 'waiting'; // waiting | active | finished
    this.players = [];       // [{ userId, username, rating, points, buchholz }]
    this.pairings = [];      // per round
    this.games = [];
    this.startTime = null;
    this.chat = [];
  }

  addPlayer(player) {
    if (this.players.find(p => p.userId === player.userId)) return false;
    this.players.push({ ...player, points: 0, buchholz: 0, opponents: [] });
    return true;
  }

  removePlayer(userId) {
    this.players = this.players.filter(p => p.userId !== userId);
  }

  start() {
    if (this.players.length < 2) return false;
    this.status = 'active';
    this.startTime = Date.now();
    this.pairRound();
    return true;
  }

  pairRound() {
    this.currentRound++;
    // Swiss pairing: sort by points, pair top vs bottom half, avoid rematches
    const sorted = [...this.players].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.buchholz - a.buchholz;
    });

    const paired = new Set();
    const roundPairings = [];
    let bye = null;

    // If odd number of players, give bye to lowest-ranked player without a bye
    if (sorted.length % 2 !== 0) {
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (!sorted[i].hadBye) {
          bye = sorted[i];
          sorted.splice(i, 1);
          break;
        }
      }
      if (!bye) bye = sorted.pop();
      if (bye) {
        bye.hadBye = true;
        bye.points += 1; // bye = full point
        roundPairings.push({ white: bye, black: null, gameId: null, result: 'bye' });
      }
    }

    // Pair remaining players
    const top = sorted.slice(0, Math.floor(sorted.length / 2));
    const bottom = sorted.slice(Math.floor(sorted.length / 2));

    for (let i = 0; i < top.length; i++) {
      let matched = false;
      for (let j = 0; j < bottom.length; j++) {
        if (!paired.has(bottom[j].userId) &&
            !top[i].opponents.includes(bottom[j].userId)) {
          const gameId = generateId();
          // Alternate colors
          const whitePlayer = top[i].colorBalance <= 0 ? top[i] : bottom[j];
          const blackPlayer = whitePlayer === top[i] ? bottom[j] : top[i];
          roundPairings.push({
            white: whitePlayer,
            black: blackPlayer,
            gameId,
            result: null
          });
          paired.add(top[i].userId);
          paired.add(bottom[j].userId);
          top[i].opponents.push(bottom[j].userId);
          bottom[j].opponents.push(top[i].userId);
          matched = true;
          break;
        }
      }
      if (!matched && !paired.has(top[i].userId)) {
        // Fallback: pair with any unpaired
        for (let j = 0; j < bottom.length; j++) {
          if (!paired.has(bottom[j].userId)) {
            const gameId = generateId();
            roundPairings.push({
              white: top[i],
              black: bottom[j],
              gameId,
              result: null
            });
            paired.add(top[i].userId);
            paired.add(bottom[j].userId);
            break;
          }
        }
      }
    }

    this.pairings.push(roundPairings);
    return roundPairings;
  }

  recordResult(gameId, winner) {
    for (const round of this.pairings) {
      const pairing = round.find(p => p.gameId === gameId);
      if (pairing) {
        pairing.result = winner;
        const whitePlayer = this.players.find(p => p.userId === pairing.white.userId);
        const blackPlayer = this.players.find(p => p.userId === pairing.black?.userId);
        if (winner === 'white' && whitePlayer) whitePlayer.points += 1;
        else if (winner === 'black' && blackPlayer) blackPlayer.points += 1;
        else if (winner === 'draw') {
          if (whitePlayer) whitePlayer.points += 0.5;
          if (blackPlayer) blackPlayer.points += 0.5;
        }
        this._updateBuchholz();
        break;
      }
    }
    // Check if round is complete
    const currentPairings = this.pairings[this.currentRound - 1];
    const allDone = currentPairings.every(p => p.result !== null);
    if (allDone) {
      if (this.currentRound >= this.maxRounds) {
        this.status = 'finished';
      } else {
        this.pairRound();
      }
    }
  }

  _updateBuchholz() {
    this.players.forEach(player => {
      player.buchholz = player.opponents.reduce((sum, oppId) => {
        const opp = this.players.find(p => p.userId === oppId);
        return sum + (opp ? opp.points : 0);
      }, 0);
    });
  }

  getStandings() {
    return [...this.players].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      return b.buchholz - a.buchholz;
    });
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      timeControl: this.timeControl,
      status: this.status,
      currentRound: this.currentRound,
      maxRounds: this.maxRounds,
      players: this.players,
      pairings: this.pairings,
      standings: this.getStandings(),
      startTime: this.startTime
    };
  }
}

// ─── Socket.io Events ──────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ── Auth / Join ─────────────────────────────────────────────────────────
  socket.on('player:join', ({ userId, username, role, rating }) => {
    onlinePlayers.set(socket.id, {
      socketId: socket.id,
      userId,
      username,
      role,
      rating: rating || 1200,
      status: 'online'
    });
    console.log(`[JOIN] ${username} (${role}) — rating ${rating}`);
    socket.emit('player:joined', { socketId: socket.id });
    broadcastLobby();

    // Send active tournaments
    socket.emit('tournaments:list', Array.from(tournaments.values()).map(t => t.toJSON()));
  });

  // ── Lobby Chat ───────────────────────────────────────────────────────────
  socket.on('lobby:chat', ({ message }) => {
    const player = onlinePlayers.get(socket.id);
    if (!player) return;
    const msg = {
      id: generateId(),
      userId: player.userId,
      username: player.username,
      role: player.role,
      message: message.slice(0, 300),
      timestamp: Date.now()
    };
    io.emit('lobby:message', msg);
  });

  // ── Challenges ───────────────────────────────────────────────────────────
  socket.on('challenge:send', ({ targetUserId, timeControl }) => {
    const challenger = onlinePlayers.get(socket.id);
    if (!challenger) return;

    // Find target socket
    const targetSocket = Array.from(onlinePlayers.entries())
      .find(([, p]) => p.userId === targetUserId);
    if (!targetSocket) {
      socket.emit('challenge:error', { message: 'Player is no longer online' });
      return;
    }

    const challengeId = generateId();
    challenges.set(challengeId, {
      challengeId,
      from: challenger,
      toSocketId: targetSocket[0],
      timeControl,
      timestamp: Date.now()
    });

    io.to(targetSocket[0]).emit('challenge:received', {
      challengeId,
      from: {
        userId: challenger.userId,
        username: challenger.username,
        role: challenger.role,
        rating: challenger.rating
      },
      timeControl
    });

    socket.emit('challenge:sent', { challengeId });
  });

  socket.on('challenge:accept', ({ challengeId }) => {
    const challenge = challenges.get(challengeId);
    if (!challenge) return;
    challenges.delete(challengeId);

    const gameId = generateId();
    // Randomly assign colors
    const whiteFirst = Math.random() < 0.5;
    const white = whiteFirst ? challenge.from : onlinePlayers.get(socket.id);
    const black = whiteFirst ? onlinePlayers.get(socket.id) : challenge.from;

    if (!white || !black) return;

    const game = new GameRoom(gameId, white, black, challenge.timeControl);
    gameRooms.set(gameId, game);

    // Mark players as in-game
    const whiteState = onlinePlayers.get(white.socketId);
    const blackState = onlinePlayers.get(black.socketId);
    if (whiteState) whiteState.status = 'playing';
    if (blackState) blackState.status = 'playing';

    // Join both to game room
    io.sockets.sockets.get(white.socketId)?.join(gameId);
    io.sockets.sockets.get(black.socketId)?.join(gameId);

    io.to(gameId).emit('game:start', {
      gameId,
      white: { userId: white.userId, username: white.username, rating: white.rating },
      black: { userId: black.userId, username: black.username, rating: black.rating },
      timeControl: challenge.timeControl,
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    });

    game.startClock();
    broadcastLobby();
  });

  socket.on('challenge:decline', ({ challengeId }) => {
    const challenge = challenges.get(challengeId);
    if (!challenge) return;
    challenges.delete(challengeId);
    io.to(challenge.from.socketId).emit('challenge:declined', { challengeId });
  });

  // ── Game Events ───────────────────────────────────────────────────────────
  socket.on('game:move', ({ gameId, move }) => {
    const game = gameRooms.get(gameId);
    if (!game || game.status !== 'playing') return;

    const player = onlinePlayers.get(socket.id);
    if (!player) return;

    // Verify it's the player's turn
    const isWhite = game.white.socketId === socket.id;
    const isBlack = game.black.socketId === socket.id;
    const correctTurn = (isWhite && game.activeColor === 'white') ||
                        (isBlack && game.activeColor === 'black');
    if (!correctTurn) return;

    const result = game.makeMove(move);
    if (!result) {
      socket.emit('game:invalidMove', { move });
      return;
    }

    io.to(gameId).emit('game:moved', {
      move: result,
      fen: game.chess.fen(),
      moveHistory: game.moveHistory,
      activeColor: game.activeColor,
      clocks: game.clocks,
      inCheck: game.chess.isCheck()
    });
  });

  socket.on('game:resign', ({ gameId }) => {
    const game = gameRooms.get(gameId);
    if (!game) return;
    const isWhite = game.white.socketId === socket.id;
    game.resign(isWhite ? 'white' : 'black');
  });

  socket.on('game:offerDraw', ({ gameId }) => {
    const game = gameRooms.get(gameId);
    if (!game) return;
    const isWhite = game.white.socketId === socket.id;
    game.offerDraw(isWhite ? 'white' : 'black');
  });

  socket.on('game:acceptDraw', ({ gameId }) => {
    const game = gameRooms.get(gameId);
    if (!game) return;
    game.acceptDraw();
  });

  socket.on('game:chat', ({ gameId, message }) => {
    const game = gameRooms.get(gameId);
    if (!game) return;
    const player = onlinePlayers.get(socket.id);
    if (!player) return;
    const msg = {
      username: player.username,
      message: message.slice(0, 200),
      timestamp: Date.now()
    };
    game.chat.push(msg);
    io.to(gameId).emit('game:message', msg);
  });

  socket.on('game:abort', ({ gameId }) => {
    const game = gameRooms.get(gameId);
    if (!game) return;
    // Can only abort if fewer than 2 moves made
    if (game.moveHistory.length < 2) {
      clearInterval(game.clockInterval);
      game.status = 'aborted';
      io.to(gameId).emit('game:over', { status: 'aborted', reason: 'abort' });
      [game.white, game.black].forEach(p => {
        const pl = onlinePlayers.get(p.socketId);
        if (pl) pl.status = 'online';
      });
      gameRooms.delete(gameId);
      broadcastLobby();
    }
  });

  // ── Tournaments ───────────────────────────────────────────────────────────
  socket.on('tournament:create', ({ name, timeControl, rounds }) => {
    const player = onlinePlayers.get(socket.id);
    if (!player) return;

    // No berserk allowed — enforce blitz time controls only
    const validTimes = [3, 5];
    if (!validTimes.includes(timeControl.minutes)) {
      socket.emit('tournament:error', { message: 'Only blitz (3+0 or 5+0) allowed. No berserk.' });
      return;
    }

    const tourneyId = generateId();
    const tourney = new Tournament(
      tourneyId, name, timeControl,
      Math.min(Math.max(rounds || 5, 3), 9),
      player.userId
    );
    tourney.addPlayer(player);
    tournaments.set(tourneyId, tourney);

    socket.join(`tourney:${tourneyId}`);
    io.emit('tournaments:list', Array.from(tournaments.values()).map(t => t.toJSON()));
    socket.emit('tournament:created', { tourneyId });
  });

  socket.on('tournament:join', ({ tourneyId }) => {
    const tourney = tournaments.get(tourneyId);
    const player = onlinePlayers.get(socket.id);
    if (!tourney || !player) return;
    if (tourney.status !== 'waiting') {
      socket.emit('tournament:error', { message: 'Tournament already started' });
      return;
    }

    tourney.addPlayer(player);
    socket.join(`tourney:${tourneyId}`);
    io.to(`tourney:${tourneyId}`).emit('tournament:update', tourney.toJSON());
    io.emit('tournaments:list', Array.from(tournaments.values()).map(t => t.toJSON()));
  });

  socket.on('tournament:start', ({ tourneyId }) => {
    const tourney = tournaments.get(tourneyId);
    const player = onlinePlayers.get(socket.id);
    if (!tourney || !player) return;
    if (tourney.createdBy !== player.userId) {
      socket.emit('tournament:error', { message: 'Only the creator can start the tournament' });
      return;
    }

    const started = tourney.start();
    if (!started) {
      socket.emit('tournament:error', { message: 'Need at least 2 players' });
      return;
    }

    // Create game rooms for round 1 pairings
    const round1 = tourney.pairings[0];
    for (const pairing of round1) {
      if (!pairing.black) continue; // bye
      const whiteSocket = Array.from(onlinePlayers.entries())
        .find(([, p]) => p.userId === pairing.white.userId);
      const blackSocket = Array.from(onlinePlayers.entries())
        .find(([, p]) => p.userId === pairing.black.userId);
      if (!whiteSocket || !blackSocket) continue;

      const gameId = pairing.gameId;
      const game = new GameRoom(
        gameId,
        onlinePlayers.get(whiteSocket[0]),
        onlinePlayers.get(blackSocket[0]),
        tourney.timeControl
      );
      game.tournamentId = tourneyId;
      gameRooms.set(gameId, game);

      io.sockets.sockets.get(whiteSocket[0])?.join(gameId);
      io.sockets.sockets.get(blackSocket[0])?.join(gameId);

      io.to(gameId).emit('game:start', {
        gameId,
        tournamentId: tourneyId,
        white: pairing.white,
        black: pairing.black,
        timeControl: tourney.timeControl,
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        round: 1
      });

      game.startClock();
    }

    io.to(`tourney:${tourneyId}`).emit('tournament:update', tourney.toJSON());
    io.emit('tournaments:list', Array.from(tournaments.values()).map(t => t.toJSON()));
  });

  socket.on('tournament:gameOver', ({ tourneyId, gameId, winner }) => {
    const tourney = tournaments.get(tourneyId);
    if (!tourney) return;
    tourney.recordResult(gameId, winner);

    // If new round, create game rooms
    if (tourney.status === 'active') {
      const currentPairings = tourney.pairings[tourney.currentRound - 1];
      for (const pairing of currentPairings) {
        if (!pairing.black || pairing.result !== null) continue;
        const whiteSocket = Array.from(onlinePlayers.entries())
          .find(([, p]) => p.userId === pairing.white.userId);
        const blackSocket = Array.from(onlinePlayers.entries())
          .find(([, p]) => p.userId === pairing.black.userId);
        if (!whiteSocket || !blackSocket) continue;

        const game = new GameRoom(
          pairing.gameId,
          onlinePlayers.get(whiteSocket[0]),
          onlinePlayers.get(blackSocket[0]),
          tourney.timeControl
        );
        game.tournamentId = tourneyId;
        gameRooms.set(pairing.gameId, game);

        io.sockets.sockets.get(whiteSocket[0])?.join(pairing.gameId);
        io.sockets.sockets.get(blackSocket[0])?.join(pairing.gameId);

        io.to(pairing.gameId).emit('game:start', {
          gameId: pairing.gameId,
          tournamentId: tourneyId,
          white: pairing.white,
          black: pairing.black,
          timeControl: tourney.timeControl,
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          round: tourney.currentRound
        });

        game.startClock();
      }
    }

    io.to(`tourney:${tourneyId}`).emit('tournament:update', tourney.toJSON());
    if (tourney.status === 'finished') {
      io.emit('tournaments:list', Array.from(tournaments.values()).map(t => t.toJSON()));
    }
  });

  socket.on('tournament:chat', ({ tourneyId, message }) => {
    const tourney = tournaments.get(tourneyId);
    const player = onlinePlayers.get(socket.id);
    if (!tourney || !player) return;
    const msg = {
      username: player.username,
      role: player.role,
      message: message.slice(0, 200),
      timestamp: Date.now()
    };
    tourney.chat.push(msg);
    io.to(`tourney:${tourneyId}`).emit('tournament:message', msg);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const player = onlinePlayers.get(socket.id);
    if (player) {
      console.log(`[-] ${player.username} disconnected`);
      // Handle active games — give opponent win after 60s if not reconnected
      for (const [gameId, game] of gameRooms.entries()) {
        if (game.white.socketId === socket.id || game.black.socketId === socket.id) {
          if (game.status === 'playing') {
            const disconnectedColor = game.white.socketId === socket.id ? 'white' : 'black';
            setTimeout(() => {
              const reconnected = Array.from(onlinePlayers.values())
                .find(p => p.userId === player.userId);
              if (!reconnected && game.status === 'playing') {
                game.resign(disconnectedColor);
              }
            }, 60000);
          }
        }
      }
      onlinePlayers.delete(socket.id);
      broadcastLobby();
    }
  });
});

// ─── Health check ──────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'GenChess server running', players: onlinePlayers.size }));

server.listen(PORT, () => {
  console.log(`♟  GenChess server running on port ${PORT}`);
});
