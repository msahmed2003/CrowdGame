// Parse room code from the URL path: /join/ABCD
const roomCode = window.location.pathname.split('/').pop().toUpperCase();
let socket = null;

// Control configurations
let controlMode = 'tilt'; // 'tilt' or 'touch'
let isConnected = false;

// Steering state
let tiltX = 0; // -1 to 1
let tiltY = 0; // -1 to 1
let isBoosting = false;
let isFiring = false;

// Calibration references
let calBeta = 0;
let calGamma = 0;
let rawBeta = 0;
let rawGamma = 0;
let hasCalibrated = false;

// DOM Elements
const permissionOverlay = document.getElementById('permissionOverlay');
const gyroBtn = document.getElementById('gyroBtn');
const joystickBtn = document.getElementById('joystickBtn');
const calibrateBtn = document.getElementById('calibrateBtn');
const trackpad = document.getElementById('trackpad');
const knob = document.getElementById('knob');
const controlSchemeLabel = document.getElementById('controlSchemeLabel');
const calibrationMsg = document.getElementById('calibrationMsg');

const metricX = document.getElementById('metricX');
const metricY = document.getElementById('metricY');

const boostBtn = document.getElementById('boostBtn');
const fireBtn = document.getElementById('fireBtn');

const mobileStatusDot = document.getElementById('mobileStatusDot');
const mobileStatusText = document.getElementById('mobileStatusText');
const reconnectOverlay = document.getElementById('reconnectOverlay');

// Initialize WebSockets
function connectSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('Connected to server!');
    // Request to join the room
    socket.emit('join-room', roomCode);
  });

  socket.on('joined-successfully', () => {
    console.log(`Joined room: ${roomCode}`);
    isConnected = true;
    mobileStatusDot.className = 'status-dot-sm pulsing-green';
    mobileStatusText.textContent = `ROOM: ${roomCode}`;
  });

  socket.on('host-disconnected', () => {
    console.log('Host disconnected!');
    isConnected = false;
    mobileStatusDot.className = 'status-dot-sm pulsing-red';
    mobileStatusText.textContent = 'HOST OFFLINE';
    reconnectOverlay.classList.remove('hidden');
  });

  socket.on('error-message', (msg) => {
    alert(msg);
    isConnected = false;
    mobileStatusDot.className = 'status-dot-sm pulsing-red';
    mobileStatusText.textContent = 'ERROR';
  });

  socket.on('disconnect', () => {
    isConnected = false;
    mobileStatusDot.className = 'status-dot-sm pulsing-red';
    mobileStatusText.textContent = 'DISCONNECTED';
  });
}

let motionCheckTimeout = null;
let receivedOrientationEvents = 0;

// Enable Device Orientation Sensors (Tilt Flight)
function setupTiltControls() {
  controlMode = 'tilt';
  controlSchemeLabel.textContent = 'TILT FLIGHT ACTIVE';
  calibrateBtn.style.display = 'block';
  
  // Hide joystick pointer events and keep knob centered
  trackpad.style.opacity = '0.4';
  resetKnobPosition();

  // Listen to orientation events
  window.addEventListener('deviceorientation', handleOrientation, true);

  // Verification loop: verify if deviceorientation events are actually firing
  receivedOrientationEvents = 0;
  if (motionCheckTimeout) clearTimeout(motionCheckTimeout);
  
  motionCheckTimeout = setTimeout(() => {
    if (receivedOrientationEvents === 0 && controlMode === 'tilt') {
      console.warn('No deviceorientation events received. Sensors blocked.');
      calibrationMsg.innerHTML = '⚠️ Gyro blocked (HTTP/iOS limitation).<br>Tap here to use Touch Trackpad.';
      calibrationMsg.style.borderColor = 'var(--neon-red)';
      calibrationMsg.style.color = 'var(--neon-red)';
      calibrationMsg.style.cursor = 'pointer';
      
      // Allow user to tap the message box to switch to trackpad
      calibrationMsg.onclick = () => {
        setupTouchControls();
        calibrationMsg.onclick = null;
      };
    }
  }, 1500);
}

// Orientation Event Handler
function handleOrientation(event) {
  if (controlMode !== 'tilt') return;

  receivedOrientationEvents++;
  
  // Reset alert message when we start receiving events successfully
  if (receivedOrientationEvents === 1) {
    calibrationMsg.innerHTML = 'Hold device level & tap CALIBRATE to center.';
    calibrationMsg.style.borderColor = 'rgba(255, 184, 0, 0.3)';
    calibrationMsg.style.color = 'var(--neon-yellow)';
    calibrationMsg.style.cursor = 'default';
    calibrationMsg.onclick = null;
  }

  // beta: front-to-back tilt (-180 to 180)
  // gamma: left-to-right tilt (-90 to 90)
  rawBeta = event.beta || 0;
  rawGamma = event.gamma || 0;

  // Calibrate first reading automatically
  if (!hasCalibrated) {
    calibrateSensors();
  }

  // Get difference from calibration baseline
  const diffBeta = rawBeta - calBeta;
  const diffGamma = rawGamma - calGamma;

  // Determine steering directions depending on device orientation angle
  // In landscape mode, rotating like a wheel shifts beta, pitching screen shifts gamma
  const screenAngle = window.orientation || (screen.orientation && screen.orientation.angle) || 90;
  
  let targetTiltX = 0;
  let targetTiltY = 0;

  // Sensitivity scales (in degrees for full activation)
  const steerSensitivity = 22; 
  const pitchSensitivity = 18;

  if (screenAngle === 90) {
    // Landscape rotated left (standard)
    targetTiltX = diffBeta / steerSensitivity;
    targetTiltY = -diffGamma / pitchSensitivity;
  } else if (screenAngle === -90 || screenAngle === 270) {
    // Landscape rotated right (upside down)
    targetTiltX = -diffBeta / steerSensitivity;
    targetTiltY = diffGamma / pitchSensitivity;
  } else {
    // Portrait (fallback, CSS will ask to rotate anyway)
    targetTiltX = diffGamma / steerSensitivity;
    targetTiltY = diffBeta / pitchSensitivity;
  }

  // Clamp values between -1.0 and 1.0
  tiltX = Math.max(-1.0, Math.min(1.0, targetTiltX));
  tiltY = Math.max(-1.0, Math.min(1.0, targetTiltY));

  // Update numerical metrics on controller HUD
  metricX.textContent = tiltX.toFixed(2);
  metricY.textContent = tiltY.toFixed(2);

  // Visually translate the touch pad knob to reflect tilt levels!
  const maxRadius = trackpad.clientWidth / 2 - knob.clientWidth / 2;
  const knobX = tiltX * maxRadius;
  const knobY = tiltY * maxRadius;
  knob.style.transform = `translate(${knobX}px, ${knobY}px)`;
}

// Calibrate gyro sensors
function calibrateSensors() {
  calBeta = rawBeta;
  calGamma = rawGamma;
  hasCalibrated = true;
  console.log(`Calibrated sensors: Beta=${calBeta.toFixed(1)}, Gamma=${calGamma.toFixed(1)}`);
  
  calibrationMsg.textContent = 'Calibrated successfully!';
  calibrationMsg.style.borderColor = 'var(--neon-cyan)';
  calibrationMsg.style.color = 'var(--neon-cyan)';
  
  setTimeout(() => {
    calibrationMsg.textContent = 'Hold level & tap CALIBRATE to center.';
    calibrationMsg.style.borderColor = 'rgba(255, 184, 0, 0.3)';
    calibrationMsg.style.color = 'var(--neon-yellow)';
  }, 2000);
}

// Enable Touch Trackpad (No Gyro Fallback)
function setupTouchControls() {
  controlMode = 'touch';
  controlSchemeLabel.textContent = 'TRACKPAD ACTIVE';
  calibrateBtn.style.display = 'none';
  trackpad.style.opacity = '1.0';
  resetKnobPosition();
  
  // Update instructions
  calibrationMsg.innerHTML = 'Drag finger on trackpad to steer ship.';
  calibrationMsg.style.borderColor = 'rgba(255, 255, 255, 0.15)';
  calibrationMsg.style.color = 'rgba(255, 255, 255, 0.6)';
  calibrationMsg.style.cursor = 'default';
  calibrationMsg.onclick = null;

  // Remove orientation listener if present
  window.removeEventListener('deviceorientation', handleOrientation, true);

  // Setup drag event listeners on trackpad
  trackpad.addEventListener('touchstart', handleTouchStart, { passive: false });
  trackpad.addEventListener('touchmove', handleTouchMove, { passive: false });
  trackpad.addEventListener('touchend', handleTouchEnd, { passive: false });
}

// Touch Handling Logic
let trackpadRect = null;

function handleTouchStart(e) {
  e.preventDefault();
  trackpadRect = trackpad.getBoundingClientRect();
  updateTouchPosition(e.touches[0]);
}

function handleTouchMove(e) {
  e.preventDefault();
  if (!trackpadRect) return;
  updateTouchPosition(e.touches[0]);
}

function handleTouchEnd(e) {
  e.preventDefault();
  trackpadRect = null;
  tiltX = 0;
  tiltY = 0;
  resetKnobPosition();
  metricX.textContent = '0.00';
  metricY.textContent = '0.00';
}

function updateTouchPosition(touch) {
  const centerX = trackpadRect.left + trackpadRect.width / 2;
  const centerY = trackpadRect.top + trackpadRect.height / 2;
  
  const dx = touch.clientX - centerX;
  const dy = touch.clientY - centerY;
  
  const maxRadius = trackpadRect.width / 2 - knob.clientWidth / 2;
  const distance = Math.hypot(dx, dy);
  
  let targetX = dx;
  let targetY = dy;
  
  // Clamp knob position inside circular boundary
  if (distance > maxRadius) {
    const angle = Math.atan2(dy, dx);
    targetX = Math.cos(angle) * maxRadius;
    targetY = Math.sin(angle) * maxRadius;
  }
  
  knob.style.transform = `translate(${targetX}px, ${targetY}px)`;
  
  // Set normalized steering values
  tiltX = targetX / maxRadius;
  tiltY = targetY / maxRadius;
  
  metricX.textContent = tiltX.toFixed(2);
  metricY.textContent = tiltY.toFixed(2);
}

function resetKnobPosition() {
  knob.style.transform = 'translate(0px, 0px)';
}

// Set up Action Buttons (Boost & Fire)
function setupActionButtons() {
  // Boost events (Touch Start/End)
  boostBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    isBoosting = true;
  }, { passive: false });

  boostBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    isBoosting = false;
  }, { passive: false });

  // Fire events
  fireBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    isFiring = true;
  }, { passive: false });

  fireBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    isFiring = false;
  }, { passive: false });
}

// Onboarding Permission Screens Handlers
gyroBtn.addEventListener('click', async () => {
  // iOS Device Orientation permission request
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const response = await DeviceOrientationEvent.requestPermission();
      if (response === 'granted') {
        setupTiltControls();
      } else {
        console.warn('Orientation permission denied, falling back to touch.');
        setupTouchControls();
      }
    } catch (err) {
      console.error('Error requesting orientation permission:', err);
      setupTouchControls();
    }
  } else {
    // Normal browser / Android
    setupTiltControls();
  }
  
  permissionOverlay.classList.add('hidden');
  connectSocket();
});

joystickBtn.addEventListener('click', () => {
  setupTouchControls();
  permissionOverlay.classList.add('hidden');
  connectSocket();
});

calibrateBtn.addEventListener('click', () => {
  if (controlMode === 'tilt') {
    calibrateSensors();
  }
});

// Periodic Input Transmitter (40Hz / 25ms tick rate)
setInterval(() => {
  if (isConnected && socket) {
    socket.emit('controller-input', {
      tiltX: tiltX,
      tiltY: tiltY,
      boost: isBoosting,
      fire: isFiring,
      // If player is on gameover screen, tapping FIRE will act as RESTART
      restart: isFiring
    });
  }
}, 25);

// DOM setup
window.addEventListener('DOMContentLoaded', () => {
  setupActionButtons();
  
  // Auto-connect socket if session has already chosen control layout (e.g. reload safety)
  // Let the user click onboarding to guarantee user gesture for gyro permissions.
});
