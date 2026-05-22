// Game Configuration and State
const GAME_STATE = {
  INTRO: 'intro',
  PLAYING: 'playing',
  GAMEOVER: 'gameover'
};

let currentState = GAME_STATE.INTRO;
let socket = null;
let roomCode = '';

// Game variables
let canvas = null;
let ctx = null;
let bgCanvas = null;
let bgCtx = null;
let animationFrameId = null;

// Game Balance Parameters
const BASE_SPEED = 4;
const BOOST_SPEED_MULTIPLIER = 2.2;
const OBSTACLE_SPAWN_CHANCE = 0.02; // chance per frame
const CRYSTAL_SPAWN_CHANCE = 0.015;

// Audio Context for dynamic sound synthesis (no asset files needed!)
let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

// Sound Effects Synthesizer
const Sound = {
  playShoot() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(800, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + 0.15);
    
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  },

  playExplode() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + 0.4);
    
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
  },

  playCollect() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, audioCtx.currentTime);
    osc.frequency.setValueAtTime(800, audioCtx.currentTime + 0.08);
    osc.frequency.setValueAtTime(1200, audioCtx.currentTime + 0.16);
    
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.25);
  },

  playDamage() {
    if (!audioCtx) return;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc1.type = 'sawtooth';
    osc2.type = 'sawtooth';
    osc1.frequency.setValueAtTime(90, audioCtx.currentTime);
    osc2.frequency.setValueAtTime(95, audioCtx.currentTime);
    osc1.frequency.linearRampToValueAtTime(50, audioCtx.currentTime + 0.3);
    osc2.frequency.linearRampToValueAtTime(50, audioCtx.currentTime + 0.3);
    
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
    
    osc1.start();
    osc2.start();
    osc1.stop(audioCtx.currentTime + 0.3);
    osc2.stop(audioCtx.currentTime + 0.3);
  }
};

// Entities Arrays
let stars = [];
let obstacles = [];
let crystals = [];
let lasers = [];
let particles = [];

// Screen shake variable
let shakeTime = 0;
let shakeIntensity = 0;

// Player Ship State
const player = {
  x: 0,
  y: 0,
  targetX: 0,
  targetY: 0,
  width: 45,
  height: 50,
  speed: 0,
  shield: 100,
  energy: 100,
  score: 0,
  crystalsCount: 0,
  tiltX: 0, // Input values from phone (-1 to 1)
  tiltY: 0,
  isBoosting: false,
  isFiring: false,
  lastFired: 0,
  fireCooldown: 180, // ms between laser shots
  trail: []
};

// Connect to Server & Setup QR code pairing
async function setupConnection() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    
    roomCode = config.roomCode;
    document.getElementById('roomCodeVal').textContent = roomCode;
    document.getElementById('joinUrlVal').textContent = config.joinUrl;
    
    // Render the QR code image
    const qrContainer = document.getElementById('qrcode');
    qrContainer.innerHTML = `<img src="${config.qrDataUrl}" alt="Join QR Code" />`;
    
    // Connect to websocket
    socket = io();
    
    // Register as host
    socket.emit('host-room', roomCode);
    
    // Socket Event listeners
    socket.on('controller-connected', () => {
      console.log('Mobile Controller Connected!');
      document.getElementById('statusDot').className = 'status-dot pulsing-green';
      document.getElementById('statusText').textContent = 'PILOT CONNECTED! GET READY';
      initAudio();
      setTimeout(startGame, 1500); // Auto start after 1.5 seconds when paired!
    });
    
    socket.on('controller-disconnected', () => {
      console.log('Mobile Controller Disconnected!');
      document.getElementById('statusDot').className = 'status-dot pulsing-red';
      document.getElementById('statusText').textContent = 'PILOT DISCONNECTED';
      pauseGameAndReturnToSetup();
    });

    socket.on('device-input', (data) => {
      if (currentState === GAME_STATE.PLAYING) {
        player.tiltX = data.tiltX;
        player.tiltY = data.tiltY;
        player.isBoosting = data.boost;
        player.isFiring = data.fire;
      } else if (currentState === GAME_STATE.GAMEOVER && data.restart) {
        startGame();
      }
    });

  } catch (error) {
    console.error('Failed to connect or generate QR Code:', error);
    document.getElementById('joinUrlVal').textContent = 'Error connecting to server. Retrying...';
    setTimeout(setupConnection, 5000);
  }
}

// Window resizing
function handleResize() {
  if (canvas) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    // Center player on resize if intro
    if (currentState === GAME_STATE.INTRO) {
      player.x = canvas.width / 2;
      player.y = canvas.height * 0.75;
      player.targetX = player.x;
      player.targetY = player.y;
    }
  }
  if (bgCanvas) {
    bgCanvas.width = window.innerWidth;
    bgCanvas.height = window.innerHeight;
    initStars(); // Re-populate stars
  }
}

// Initialize stars background (Parallax layers)
function initStars() {
  stars = [];
  const numStars = 100;
  for (let i = 0; i < numStars; i++) {
    stars.push({
      x: Math.random() * bgCanvas.width,
      y: Math.random() * bgCanvas.height,
      size: Math.random() * 2 + 0.5,
      speed: Math.random() * 1.5 + 0.2 // Parallax speed factor
    });
  }
}

// Spark/glow particle system
function spawnParticles(x, y, color, count = 10) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 4 + 1;
    particles.push({
      x: x,
      y: y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: Math.random() * 4 + 1,
      color: color,
      alpha: 1,
      decay: Math.random() * 0.03 + 0.015
    });
  }
}

// Trigger screen shake
function triggerShake(intensity, durationFrames) {
  shakeIntensity = intensity;
  shakeTime = durationFrames;
}

// Start/Reset Game Loop
function startGame() {
  // Reset player attributes
  player.shield = 100;
  player.energy = 100;
  player.score = 0;
  player.crystalsCount = 0;
  player.x = canvas.width / 2;
  player.y = canvas.height * 0.75;
  player.targetX = player.x;
  player.targetY = player.y;
  player.tiltX = 0;
  player.tiltY = 0;
  player.isBoosting = false;
  player.isFiring = false;
  player.trail = [];
  
  obstacles = [];
  crystals = [];
  lasers = [];
  particles = [];
  
  // Update HUD fills
  document.getElementById('shieldFill').style.width = '100%';
  document.getElementById('energyFill').style.width = '100%';
  document.getElementById('shieldText').textContent = '100%';
  document.getElementById('energyText').textContent = '100%';
  
  // Transition screens
  document.getElementById('setupScreen').classList.add('hidden');
  document.getElementById('gameOverScreen').classList.add('hidden');
  document.getElementById('gameContainer').classList.remove('hidden');
  
  currentState = GAME_STATE.PLAYING;
  
  // Cancel existing animation loop if any
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
  
  // Start loop
  gameLoop();
}

function pauseGameAndReturnToSetup() {
  currentState = GAME_STATE.INTRO;
  
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
  
  document.getElementById('setupScreen').classList.remove('hidden');
  document.getElementById('gameContainer').classList.add('hidden');
  document.getElementById('gameOverScreen').classList.add('hidden');
}

function endGame() {
  currentState = GAME_STATE.GAMEOVER;
  
  Sound.playExplode();
  spawnParticles(player.x, player.y, '#ff007f', 40);
  spawnParticles(player.x, player.y, '#ffb800', 30);
  
  document.getElementById('finalScoreVal').textContent = player.score;
  document.getElementById('finalCrystalsVal').textContent = player.crystalsCount;
  
  document.getElementById('gameContainer').classList.add('hidden');
  document.getElementById('gameOverScreen').classList.remove('hidden');
}

// Update game physics & objects
function update() {
  const currentSpeed = BASE_SPEED * (player.isBoosting && player.energy > 0 ? BOOST_SPEED_MULTIPLIER : 1);
  player.speed = currentSpeed;
  
  // 1. Handle Boost Energy drain/recharge
  const boostIndicator = document.getElementById('boostIndicator');
  if (player.isBoosting && player.energy > 0) {
    player.energy = Math.max(0, player.energy - 0.4);
    boostIndicator.classList.add('active');
    // Spawn thrust trail particles
    if (Math.random() < 0.5) {
      spawnParticles(player.x + (Math.random() * 20 - 10), player.y + 25, '#00f3ff', 2);
    }
  } else {
    player.energy = Math.min(100, player.energy + 0.15);
    boostIndicator.classList.remove('active');
  }
  
  // Update HUD energy bar
  document.getElementById('energyFill').style.width = `${player.energy}%`;
  document.getElementById('energyText').textContent = `${Math.round(player.energy)}%`;
  
  // 2. Interpolate player positions from tilts
  // tiltX maps to horizontal steering, tiltY maps to vertical pitch
  // Limit values to screen edges
  const maxTiltRangeX = canvas.width * 0.45; // limit travel to 45% screen width from center
  const maxTiltRangeY = canvas.height * 0.4;
  
  player.targetX = (canvas.width / 2) + (player.tiltX * maxTiltRangeX);
  player.targetY = (canvas.height * 0.6) + (player.tiltY * maxTiltRangeY);
  
  // Smooth position interpolation (LERP)
  player.x += (player.targetX - player.x) * 0.12;
  player.y += (player.targetY - player.y) * 0.12;
  
  // Keep ship inside boundaries
  player.x = Math.max(30, Math.min(canvas.width - 30, player.x));
  player.y = Math.max(30, Math.min(canvas.height - 30, player.y));
  
  // Save ship trail coordinates
  player.trail.push({ x: player.x, y: player.y });
  if (player.trail.length > 8) {
    player.trail.shift();
  }
  
  // 3. Firing Lasers
  if (player.isFiring && Date.now() - player.lastFired > player.fireCooldown) {
    lasers.push({
      x: player.x,
      y: player.y - player.height / 2,
      vy: -15,
      width: 4,
      height: 18
    });
    player.lastFired = Date.now();
    Sound.playShoot();
  }
  
  // Move Lasers
  for (let i = lasers.length - 1; i >= 0; i--) {
    const l = lasers[i];
    l.y += l.vy;
    if (l.y < 0) {
      lasers.splice(i, 1);
    }
  }
  
  // 4. Update Stars background parallax speed based on ship speed
  stars.forEach(s => {
    s.y += s.speed * currentSpeed * 0.5;
    if (s.y > bgCanvas.height) {
      s.y = 0;
      s.x = Math.random() * bgCanvas.width;
    }
  });
  
  // 5. Spawn & Update Obstacles (Asteroids)
  if (Math.random() < OBSTACLE_SPAWN_CHANCE) {
    const size = Math.random() * 40 + 20;
    obstacles.push({
      x: Math.random() * (canvas.width - 60) + 30,
      y: -50,
      vy: Math.random() * 3 + 2,
      vx: Math.random() * 2 - 1,
      size: size,
      angle: Math.random() * Math.PI * 2,
      spinSpeed: Math.random() * 0.04 - 0.02,
      hp: Math.ceil(size / 20),
      maxHp: Math.ceil(size / 20),
      points: Math.round(size * 10)
    });
  }
  
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    o.y += o.vy * (currentSpeed / BASE_SPEED);
    o.x += o.vx;
    o.angle += o.spinSpeed;
    
    // Check if off screen
    if (o.y > canvas.height + 50) {
      obstacles.splice(i, 1);
    }
  }
  
  // 6. Spawn & Update Crystals (Collectibles)
  if (Math.random() < CRYSTAL_SPAWN_CHANCE) {
    crystals.push({
      x: Math.random() * (canvas.width - 60) + 30,
      y: -30,
      vy: Math.random() * 2 + 1.5,
      size: 15,
      angle: 0,
      pulse: 0
    });
  }
  
  for (let i = crystals.length - 1; i >= 0; i--) {
    const c = crystals[i];
    c.y += c.vy * (currentSpeed / BASE_SPEED);
    c.angle += 0.05;
    c.pulse = Math.sin(c.angle) * 3;
    
    if (c.y > canvas.height + 30) {
      crystals.splice(i, 1);
    }
  }
  
  // 7. Update Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.alpha -= p.decay;
    if (p.alpha <= 0) {
      particles.splice(i, 1);
    }
  }
  
  // 8. Collision Detections
  
  // Lasers vs Obstacles
  for (let lIdx = lasers.length - 1; lIdx >= 0; lIdx--) {
    const l = lasers[lIdx];
    for (let oIdx = obstacles.length - 1; oIdx >= 0; oIdx--) {
      const o = obstacles[oIdx];
      
      // Box-circle-ish distance collision check
      const dist = Math.hypot(l.x - o.x, l.y - o.y);
      if (dist < o.size + 5) {
        // Laser hit asteroid
        lasers.splice(lIdx, 1);
        o.hp--;
        
        spawnParticles(l.x, l.y, '#00f3ff', 4);
        
        if (o.hp <= 0) {
          Sound.playExplode();
          spawnParticles(o.x, o.y, '#ff3333', 15);
          player.score += o.points;
          obstacles.splice(oIdx, 1);
        }
        break;
      }
    }
  }
  
  // Player vs Obstacles
  for (let i = obstacles.length - 1; i >= 0; i--) {
    const o = obstacles[i];
    const dist = Math.hypot(player.x - o.x, player.y - o.y);
    if (dist < o.size + player.width / 2.5) {
      // Impact!
      obstacles.splice(i, 1);
      triggerShake(12, 10);
      Sound.playDamage();
      spawnParticles(o.x, o.y, '#ff3333', 20);
      
      const dmg = Math.round(o.size * 0.6);
      player.shield = Math.max(0, player.shield - dmg);
      
      // Update HUD shield bar
      document.getElementById('shieldFill').style.width = `${player.shield}%`;
      document.getElementById('shieldText').textContent = `${player.shield}%`;
      
      if (player.shield <= 0) {
        endGame();
        return;
      }
    }
  }
  
  // Player vs Crystals
  for (let i = crystals.length - 1; i >= 0; i--) {
    const c = crystals[i];
    const dist = Math.hypot(player.x - c.x, player.y - c.y);
    if (dist < c.size + player.width / 2.5) {
      crystals.splice(i, 1);
      Sound.playCollect();
      spawnParticles(c.x, c.y, '#ffb800', 12);
      
      player.crystalsCount++;
      player.score += 250;
      
      // Heal shield slightly upon collecting crystals
      player.shield = Math.min(100, player.shield + 8);
      document.getElementById('shieldFill').style.width = `${player.shield}%`;
      document.getElementById('shieldText').textContent = `${Math.round(player.shield)}%`;
    }
  }
  
  // 9. Passive Score Accumulation (higher score when moving fast)
  player.score += Math.round(currentSpeed * 0.1);
  
  // 10. Update HUD Text values
  const scoreStr = String(player.score).padStart(6, '0');
  document.getElementById('scoreVal').textContent = scoreStr;
  
  const displaySpeed = Math.round(currentSpeed * 300);
  document.getElementById('speedVal').textContent = `${displaySpeed} km/h`;
}

// Draw game frame to canvas
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Apply Screen Shake
  ctx.save();
  if (shakeTime > 0) {
    const dx = (Math.random() - 0.5) * shakeIntensity;
    const dy = (Math.random() - 0.5) * shakeIntensity;
    ctx.translate(dx, dy);
    shakeTime--;
  }
  
  // 1. Draw Crystals
  crystals.forEach(c => {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.angle);
    
    // Draw neon diamond outline
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#ffb800';
    ctx.strokeStyle = '#ffb800';
    ctx.lineWidth = 3;
    ctx.fillStyle = 'rgba(255, 184, 0, 0.2)';
    
    const size = c.size + c.pulse;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, 0);
    ctx.lineTo(0, size);
    ctx.lineTo(-size * 0.7, 0);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  });
  
  // 2. Draw Obstacles (Asteroids)
  obstacles.forEach(o => {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.angle);
    
    ctx.shadowBlur = 12;
    ctx.shadowColor = '#ff3333';
    ctx.strokeStyle = '#ff3333';
    ctx.lineWidth = 2.5;
    ctx.fillStyle = 'rgba(255, 51, 51, 0.1)';
    
    // Draw polygon representation of asteroid
    ctx.beginPath();
    const numSides = 7;
    for (let i = 0; i < numSides; i++) {
      const angle = (i / numSides) * Math.PI * 2;
      const variance = 0.8 + (Math.sin(angle * 3) * 0.15); // jagged edges
      const px = Math.cos(angle) * o.size * variance;
      const py = Math.sin(angle) * o.size * variance;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    
    // Draw HP indicator cracks if damaged
    if (o.hp < o.maxHp) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-o.size/2, -o.size/4);
      ctx.lineTo(o.size/4, o.size/3);
      ctx.stroke();
    }
    
    ctx.restore();
  });
  
  // 3. Draw Lasers
  lasers.forEach(l => {
    ctx.save();
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#00f3ff';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(l.x - l.width / 2, l.y, l.width, l.height);
    
    // Draw outer glow block
    ctx.strokeStyle = 'rgba(0, 243, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(l.x - l.width / 2 - 1, l.y - 1, l.width + 2, l.height + 2);
    ctx.restore();
  });
  
  // 4. Draw Particles
  particles.forEach(p => {
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.shadowBlur = p.size * 2;
    ctx.shadowColor = p.color;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
  
  // 5. Draw Player Spaceship with trails
  if (player.trail.length > 1) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 0, 127, 0.15)';
    ctx.lineWidth = player.width * 0.7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(player.trail[0].x, player.trail[0].y);
    for (let i = 1; i < player.trail.length; i++) {
      ctx.lineTo(player.trail[i].x, player.trail[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }
  
  ctx.save();
  ctx.translate(player.x, player.y);
  
  // Apply a visually cool banking rotation based on tilt/motion
  const rollAngle = player.tiltX * 0.35; // Bank up to ~20 degrees
  ctx.rotate(rollAngle);
  
  // Glowing ship neon design
  ctx.shadowBlur = 20;
  ctx.shadowColor = '#ff007f';
  ctx.strokeStyle = '#ff007f';
  ctx.lineWidth = 3.5;
  ctx.fillStyle = '#0f0926'; // Deep fill
  
  // Draw sleek futuristic triangle fighter ship
  ctx.beginPath();
  // Nose tip
  ctx.moveTo(0, -player.height / 2);
  // Bottom right wingtip
  ctx.lineTo(player.width / 2, player.height / 2);
  // Inner bottom thrust thruster indent
  ctx.lineTo(0, player.height * 0.25);
  // Bottom left wingtip
  ctx.lineTo(-player.width / 2, player.height / 2);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  
  // Draw glowing cockpit glass
  ctx.shadowColor = '#00f3ff';
  ctx.strokeStyle = '#00f3ff';
  ctx.lineWidth = 2;
  ctx.fillStyle = 'rgba(0, 243, 255, 0.3)';
  ctx.beginPath();
  ctx.moveTo(0, -player.height * 0.25);
  ctx.lineTo(player.width * 0.2, player.height * 0.05);
  ctx.lineTo(0, player.height * 0.12);
  ctx.lineTo(-player.width * 0.2, player.height * 0.05);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  
  // Draw active thruster flame
  ctx.shadowColor = '#ffb800';
  ctx.fillStyle = '#ffb800';
  const flameHeight = player.isBoosting ? 35 : 15;
  const flameFlicker = Math.random() * 6 - 3;
  ctx.beginPath();
  ctx.moveTo(-8, player.height * 0.25 + 2);
  ctx.lineTo(0, player.height * 0.25 + flameHeight + flameFlicker);
  ctx.lineTo(8, player.height * 0.25 + 2);
  ctx.closePath();
  ctx.fill();
  
  ctx.restore();
  
  ctx.restore(); // Restore shake transforms
}

// Background draw (draws stars with lower refresh rate/independent logic)
function drawBackground() {
  bgCtx.fillStyle = '#080516';
  bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  
  bgCtx.fillStyle = '#ffffff';
  stars.forEach(s => {
    bgCtx.globalAlpha = s.speed / 1.7; // Brighter stars are faster
    bgCtx.fillRect(s.x, s.y, s.size, s.size);
  });
  bgCtx.globalAlpha = 1.0;
}

// Main tick loop
function gameLoop() {
  if (currentState === GAME_STATE.PLAYING) {
    update();
    draw();
  }
  
  drawBackground();
  
  animationFrameId = requestAnimationFrame(gameLoop);
}

// Main initialisation
window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('gameCanvas');
  ctx = canvas.getContext('2d');
  
  bgCanvas = document.getElementById('bgCanvas');
  bgCtx = bgCanvas.getContext('2d');
  
  window.addEventListener('resize', handleResize);
  handleResize(); // sets widths/heights and generates stars
  
  setupConnection();
  
  // Pre-game loop (just runs background animations)
  gameLoop();
});
