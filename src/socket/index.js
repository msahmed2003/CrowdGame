const jwt = require('jsonwebtoken');
const config = require('../config');
const RoomManager = require('./roomManager');

function initSockets(io) {
  const roomManager = new RoomManager(io);

  // ─── Admin Auth Middleware ─────────────────────────────────────────────────
  // Sockets that supply a valid admin JWT in socket.handshake.auth.token get
  // socket.isAdmin = true.  All other sockets are treated as regular clients.
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (token) {
      try {
        const payload = jwt.verify(token, config.JWT_SECRET);
        if (payload.role === 'admin') {
          socket.isAdmin = true;
        }
      } catch (_) {
        // Token present but invalid — continue as regular client (don't reject,
        // because mobile players connect without any token at all)
      }
    }
    next();
  });

  io.on('connection', (socket) => {
    // console.log(`Socket connection: ${socket.id}`);

    // 1. Host Room creation (Desktop Big Screen or Admin pre-init)
    socket.on('host-room', async (roomCode) => {
      console.log(`Host connection request. Custom room code: ${roomCode}`);
      try {
        // If the room already exists (admin pre-created it via the admin panel),
        // don't wipe it — just transfer the display host to this socket.
        const existingRoom = roomManager.getRoom(roomCode);

        let room;
        if (existingRoom) {
          existingRoom.hostSocketId = socket.id;
          room = existingRoom;
          console.log(`Screen display connected to existing room: ${roomCode}`);
        } else {
          room = await roomManager.createRoom(socket.id, roomCode);
        }

        socket.join(room.roomCode);
        socket.roomCode = room.roomCode;
        socket.role = 'host';

        socket.emit('room-created', {
          roomCode: room.roomCode,
          status: room.status
        });

        // =====================================================
        // NEW FEATURE START : SEND FEED HISTORY
        // =====================================================

        socket.emit(
          'activity-feed-update',
          room.activityFeed || []
        );

        // =====================================================
        // NEW FEATURE END : SEND FEED HISTORY
        // =====================================================

        // If the activity was already started (admin started before screen opened),
        // push the current full puzzle state to the screen immediately.
        if (room.activity) {
          socket.emit('activity-start', {
            type: 'jigsaw',
            state: room.activity.getStateForScreen()
          });
        }
      } catch (err) {
        console.error('Error in host-room setup:', err);
        socket.emit('error-message', 'Failed to create room.');
      }
    });

    // 2. Mobile Player joins room
    socket.on('join-room', ({ roomCode, displayName }) => {
      roomCode = roomCode.toUpperCase();
      console.log(`Player '${displayName}' requesting join for Room: ${roomCode}`);

      const result = roomManager.joinRoom(roomCode, socket.id, displayName);
      if (!result.success) {
        socket.emit('error-message', result.error);
        return;
      }

      socket.join(roomCode);
      socket.roomCode = roomCode;
      socket.role = 'player';
      socket.playerId = result.participant.id;

      socket.emit('joined-successfully', {
        playerId: result.participant.id,
        color: result.participant.color,
        displayName: result.participant.displayName
      });

      // =====================================================
      // NEW FEATURE START : LIVE FEED
      // =====================================================

      roomManager.addActivity(
        roomCode,
        `🧩 ${displayName} joined the puzzle`
      );

      // =====================================================
      // NEW FEATURE END : LIVE FEED
      // =====================================================

      // Broadcast updated participant list to everyone in the room
      const room = roomManager.getRoom(roomCode);
      io.to(roomCode).emit('room-update', {
        status: room.status,
        participantsCount: roomManager.getConnectedCount(roomCode)
      });

      // =====================================================
      // FIX ADMIN DASHBOARD : PLAYER COUNT
      // =====================================================

      io.emit('admin-player-count', {
        count: roomManager.getConnectedCount(roomCode),
        displayName: result.participant.displayName
      });

      // If activity is already running, send the starting state immediately to the new player
      if (room.activity) {
        socket.emit('activity-start', {
          type: 'jigsaw',
          state: room.activity.getStateForPlayer(socket.playerId)
        });
      }
    });

    // 3. Admin / Host starts activity
    // ── Auth guard ────────────────────────────────────────────────────────────
    // The requesting socket must either:
    //   a) carry a valid admin JWT (socket.isAdmin), OR
    //   b) be the registered host socket for that room.
    // This prevents any arbitrary player from starting or restarting the game.
    socket.on('admin-start-activity', async ({ roomCode, rows, cols, imageUrl }) => {
      console.log(`Admin requested activity start in room: ${roomCode}`);

      const room = roomManager.getRoom(roomCode);
      if (!room) {
        socket.emit('error-message', 'Room not found.');
        return;
      }

      // ── Authorization check ──
      const isRoomHost = socket.id === room.hostSocketId;
      if (!socket.isAdmin && !isRoomHost) {
        console.warn(`Unauthorized admin-start-activity attempt from socket ${socket.id}`);
        socket.emit('error-message', 'Unauthorized: only the room host or admin can start an activity.');
        return;
      }

      const activityConfig = {
        rows: parseInt(rows) || 4,
        cols: parseInt(cols) || 6,
        imageUrl: imageUrl
      };

      const result = await roomManager.startActivity(roomCode, 'jigsaw', activityConfig);
      if (!result.success) {
        socket.emit('error-message', result.error);
        return;
      }
      // ===== NEW FEATURE: TIMER START =====
      room.startedAt = Date.now();
      // ===== END =====

      // Notify host and all players that the activity has started
      io.to(room.hostSocketId).emit('activity-start', {
        type: 'jigsaw',
        state: room.activity.getStateForScreen()
      });

      // Send personalized starting configurations to each player
      room.participants.forEach((p) => {
        if (p.isConnected && p.socketId) {
          io.to(p.socketId).emit('activity-start', {
            type: 'jigsaw',
            state: room.activity.getStateForPlayer(p.id)
          });
        }
      });
    });

    // 4. Jigsaw placement action from players
    socket.on('move-piece', (actionData) => {
      if (socket.role !== 'player' || !socket.roomCode) return;
      const room = roomManager.getRoom(socket.roomCode);
      if (!room || !room.activity || room.status !== 'active') return;

      const player = room.participants.get(socket.playerId);
      if (!player) return;

      const { pieceId, currentX, currentY } = actionData;
      const piece = room.activity.pieces.find(p => p.id === pieceId);
      if (piece && piece.assignedTo === player.id && !piece.isPlaced) {
        piece.currentX = currentX;
        piece.currentY = currentY;
        io.to(room.hostSocketId).emit('piece-move', { pieceId, currentX, currentY });
      }
    });

    socket.on('place-piece', (actionData) => {
      if (socket.role !== 'player' || !socket.roomCode) return;

      const room = roomManager.getRoom(socket.roomCode);
      if (!room || !room.activity || room.status !== 'active') return;

      const player = room.participants.get(socket.playerId);
      if (!player) return;

      const result = room.activity.onPlayerAction(player, 'place-piece', actionData);
      if (!result || !result.success) {
        socket.emit('error-message', result ? result.error : 'Action failed');
        return;
      }

      // If correct, broadcast placement update to all clients in the room
      if (result.correct) {
        io.to(socket.roomCode).emit('piece-placed', {
          pieceId: result.pieceId,
          correctX: result.correctX,
          correctY: result.correctY,
          placedBy: result.placedBy,
          score: result.score,
          progress: result.progress,
          isSolved: result.isSolved
        });

        // =====================================================
        // FIX ADMIN DASHBOARD : PROGRESS
        // =====================================================

        io.emit('piece-placed', {
          correct: true,
          placedBy: result.placedBy,
          progress: result.progress
        });

        // Send a fresh set of assigned pieces specifically to the placing player
        socket.emit('assign-pieces', {
          assignedPieces: room.activity.getStateForPlayer(socket.playerId).assignedPieces
        });

        // =====================================================
        // NEW FEATURE START : LIVE FEED
        // =====================================================

        roomManager.addActivity(
          socket.roomCode,
          `🎯 ${player.displayName} placed a puzzle piece`
        );

        // =====================================================
        // NEW FEATURE END : LIVE FEED
        // =====================================================

        // =====================================================
        // NEW FEATURE START : PROGRESS FEED
        // =====================================================

        const progress = Math.round(result.progress);

        if (progress === 25) {
          roomManager.addActivity(
            socket.roomCode,
            '⚡ Puzzle is 25% complete'
          );
        }

        if (progress === 50) {
          roomManager.addActivity(
            socket.roomCode,
            '⚡ Puzzle is 50% complete'
          );
        }

        if (progress === 75) {
          roomManager.addActivity(
            socket.roomCode,
            '⚡ Puzzle is 75% complete'
          );
        }

        // =====================================================
        // NEW FEATURE END : PROGRESS FEED
        // =====================================================

        // =====================================================
        // NEW FEATURE START : LIVE LEADERBOARD
        // =====================================================

        const liveLeaderboard =
          Array.from(room.participants.values())
            .map(p => ({
              displayName: p.displayName,
              score: p.score,
              color: p.color,

              piecesPlaced:
                p.correctPlacements || 0,

              accuracy:
                p.totalAttempts > 0
                  ? Math.round(
                    (
                      p.correctPlacements /
                      p.totalAttempts
                    ) * 100
                  )
                  : 0
            }))
            .sort(
              (a, b) =>
                b.score - a.score
            );

        io.to(socket.roomCode).emit(
          'leaderboard-update',
          liveLeaderboard
        );

        // =====================================================
        // NEW FEATURE END : LIVE LEADERBOARD
        // =====================================================

        if (result.isSolved) {

          // =====================================================
          // NEW FEATURE START : LIVE FEED
          // =====================================================

          roomManager.addActivity(
            socket.roomCode,
            '🏆 Puzzle solved successfully!'
          );

          // =====================================================
          // NEW FEATURE END : LIVE FEED
          // =====================================================

          // =====================================================
          // NEW FEATURE START : COMPLETION TIMER
          // =====================================================

          const completionTime =
            room.startedAt
              ? Math.floor(
                (
                  Date.now() -
                  room.startedAt
                ) / 1000
              )
              : 0;

          // =====================================================
          // NEW FEATURE END : COMPLETION TIMER
          // =====================================================


          // =====================================================
          // NEW FEATURE START : MVP STATISTICS
          // =====================================================

          const leaderboard =
            Array.from(
              room.participants.values()
            )
              .map(p => ({
                displayName:
                  p.displayName,

                score:
                  p.score,

                color:
                  p.color,

                piecesPlaced:
                  p.correctPlacements || 0,

                accuracy:
                  p.totalAttempts > 0
                    ? Math.round(
                      (
                        p.correctPlacements /
                        p.totalAttempts
                      ) * 100
                    )
                    : 0
              }))
              .sort(
                (a, b) =>
                  b.score - a.score
              );

          // =====================================================
          // NEW FEATURE END : MVP STATISTICS
          // =====================================================

          // =====================================================
          // NEW FEATURE START : ACHIEVEMENTS
          // =====================================================

          const achievements = [];

          if (leaderboard.length > 0) {

            achievements.push({
              title: '🏆 Puzzle Master',
              player: leaderboard[0].displayName
            });

            const bestAccuracy =
              [...leaderboard]
                .sort(
                  (a, b) =>
                    b.accuracy - a.accuracy
                )[0];

            achievements.push({
              title: '🎯 Sharpshooter',
              player: bestAccuracy.displayName
            });

            const mostPieces =
              [...leaderboard]
                .sort(
                  (a, b) =>
                    b.piecesPlaced - a.piecesPlaced
                )[0];

            achievements.push({
              title: '⚡ Speed Builder',
              player: mostPieces.displayName
            });
          }

          // =====================================================
          // NEW FEATURE END : ACHIEVEMENTS
          // =====================================================



          // =====================================================
          // NEW FEATURE START : TEAM ANALYTICS
          // =====================================================

          const analytics = {

            totalPlayers:
              room.participants.size,

            averageAccuracy:
              leaderboard.length
                ? Math.round(
                  leaderboard.reduce(
                    (sum, p) =>
                      sum + p.accuracy,
                    0
                  ) / leaderboard.length
                )
                : 0,

            totalScore:
              leaderboard.reduce(
                (sum, p) =>
                  sum + p.score,
                0
              ),

            totalPieces:
              room.activity.totalPieces
          };

          // =====================================================
          // NEW FEATURE END : TEAM ANALYTICS
          // =====================================================


          // =====================================================
          // NEW FEATURE START : COMPLETION PAYLOAD
          // =====================================================

          io.to(socket.roomCode).emit(
            'activity-complete',
            {
              leaderboard,

              totalPieces:
                room.activity.totalPieces,

              completionTime,

              achievements,

              analytics
            }
          );

          // =====================================================
          // NEW FEATURE END : COMPLETION PAYLOAD
          // =====================================================

          room.status = 'completed';
        }
      } else {
        // Sync drag coordinates to the big screen for live visual feedback
        io.to(room.hostSocketId).emit('piece-move', {
          pieceId: result.pieceId,
          currentX: result.currentX,
          currentY: result.currentY
        });

        // Notify the player of the incorrect placement
        socket.emit('placement-incorrect', { pieceId: result.pieceId });
      }
    });

    // 5. Clean up on socket disconnect
    socket.on('disconnect', () => {
      roomManager.handleDisconnect(socket.id);
    });
  });
}

module.exports = initSockets;
