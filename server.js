const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');

const app = express();
const PORT = process.env.PORT || 3000;

// Helper to get local network IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const ipCandidates = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ipCandidates.push(iface.address);
      }
    }
  }
  
  const privateIPPattern = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;
  const preferredIP = ipCandidates.find(ip => privateIPPattern.test(ip));
  
  return preferredIP || ipCandidates[0] || 'localhost';
}

const LOCAL_IP = getLocalIP();

// Generate dynamic SSL certificates for secure accelerometer access on mobile devices
console.log('Generating dynamic self-signed SSL certificates for HTTPS...');
const attrs = [
  { name: 'commonName', value: LOCAL_IP }
];
// subjectAltName helps avoid some browser security bypass roadblocks
const options = {
  days: 30,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [{
    name: 'subjectAltName',
    altNames: [
      { type: 2, value: 'localhost' },
      { type: 7, ip: LOCAL_IP }
    ]
  }]
};

const pems = selfsigned.generate(attrs, options);

const server = https.createServer({
  key: pems.private,
  cert: pems.cert
}, app);

const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Route for the mobile controller client (accessed via QR code)
app.get('/join/:roomCode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

// API endpoint to retrieve connection configuration
app.get('/api/config', async (req, res) => {
  const roomCode = req.query.roomCode || Math.random().toString(36).substring(2, 6).toUpperCase();
  const joinUrl = `https://${LOCAL_IP}:${PORT}/join/${roomCode}`;
  
  try {
    // Generate QR code data URL
    const qrDataUrl = await QRCode.toDataURL(joinUrl, {
      color: {
        dark: '#ffffff', // White QR code
        light: '#120d2d', // Synthwave dark background color
      },
      margin: 1,
      width: 256,
    });
    
    res.json({
      localIp: LOCAL_IP,
      port: PORT,
      roomCode,
      joinUrl,
      qrDataUrl
    });
  } catch (err) {
    console.error('Error generating QR code:', err);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Socket.io Real-time connection management
const rooms = new Map(); // roomCode -> { hostSocketId, controllerSocketId }

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Handle Host connection
  socket.on('host-room', (roomCode) => {
    roomCode = roomCode.toUpperCase();
    console.log(`Host requesting room creation: ${roomCode}`);
    
    // Register the room
    rooms.set(roomCode, {
      hostSocketId: socket.id,
      controllerSocketId: null
    });
    
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.role = 'host';
  });

  // Handle Mobile Controller connection
  socket.on('join-room', (roomCode) => {
    roomCode = roomCode.toUpperCase();
    console.log(`Controller requesting to join room: ${roomCode}`);
    
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error-message', 'Room not found. Please refresh the game screen.');
      return;
    }
    
    if (room.controllerSocketId) {
      console.log(`Room ${roomCode} already has a controller. Reconnecting/Replacing.`);
      // We can disconnect/replace or alert. Let's replace and notify the host.
      io.to(room.controllerSocketId).emit('error-message', 'Disconnected: A new controller has joined.');
    }
    
    room.controllerSocketId = socket.id;
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.role = 'controller';
    
    // Notify host that the controller connected
    io.to(room.hostSocketId).emit('controller-connected');
    socket.emit('joined-successfully');
  });

  // Forward controller inputs to the host
  socket.on('controller-input', (data) => {
    if (socket.role === 'controller' && socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room && room.hostSocketId) {
        // Forward data directly to the host
        io.to(room.hostSocketId).emit('device-input', data);
      }
    }
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    
    if (socket.roomCode) {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      
      if (room) {
        if (socket.role === 'host') {
          console.log(`Host disconnected from room: ${roomCode}`);
          // Notify controller and delete the room
          if (room.controllerSocketId) {
            io.to(room.controllerSocketId).emit('host-disconnected');
          }
          rooms.delete(roomCode);
        } else if (socket.role === 'controller') {
          console.log(`Controller disconnected from room: ${roomCode}`);
          // Notify host and reset controller ID
          room.controllerSocketId = null;
          io.to(room.hostSocketId).emit('controller-disconnected');
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log('==================================================');
  console.log(`  Synthwave Spaceship Game Server Running (HTTPS)!`);
  console.log(`  Access Big Screen Game at: https://localhost:${PORT}`);
  console.log(`  Access Mobile via IP:      https://${LOCAL_IP}:${PORT}`);
  console.log('  Note: Accept the self-signed certificate warning');
  console.log('  on both your desktop and phone to proceed.');
  console.log('==================================================');
});
