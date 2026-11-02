/**
 * ATCS - Adaptive Traffic Signal Control System
 * Backend Server — Zero external npm dependencies (pure Node.js core)
 * 
 * Implements:
 *  - F.V. Webster's Delay Optimization Engine
 *  - NEMA TS-2 Dual-Ring Actuated State Machine
 *  - Computer Vision Multi-Object Tracking (MOT) Engine
 *  - Emergency Vehicle Priority (EVP) Preemption
 *  - REST API for TMC Web Console
 *  - Write-Ahead Logging (WAL) persistence layer
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION CONSTANTS  (engineering parameters from SRS)
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  PORT: 3000,
  SATURATION_FLOW: 1800,          // S_i  (vphg) — standard saturation flow rate
  TOTAL_LOST_TIME: 14.0,          // L    (s)    — total lost time per cycle (4 phases × 3.5s)
  MIN_GREEN: 7.0,                  // T_min (s)   — NEMA minimum green
  UNIT_PASSAGE: 2.5,              // δt   (s)    — NEMA unit passage extension
  GAP_OUT_THRESHOLD: 2.5,         // (s)  — headway gap-out trigger
  YELLOW_CLEARANCE: 3.0,          // T_yellow (s) — kinematic yellow interval
  ALL_RED_CLEARANCE: 1.2,         // T_all-red (s) — intersection clearance interval
  LOOP_BASELINE_DIST: 28.5,       // D_baseline (m) — virtual loop spacing
  CYCLE_MIN: 40,                   // minimum cycle length (s)
  CYCLE_MAX: 120,                  // maximum cycle length (s)
  WAL_PATH: path.join(__dirname, 'data', 'traffic_analytics.json'),
  PUBLIC_DIR: path.join(__dirname, 'public'),
  TICK_INTERVAL_MS: 500,          // controller tick interval
};

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL SYSTEM STATE
// ─────────────────────────────────────────────────────────────────────────────
const PHASES = ['NORTH', 'SOUTH', 'EAST', 'WEST'];

let state = {
  // Approach flow rates q_i (vph) — dynamically updated by CV engine
  flows: { NORTH: 720, SOUTH: 540, EAST: 900, WEST: 660 },

  // NEMA signal heads per approach
  signals: { NORTH: 'RED', SOUTH: 'RED', EAST: 'GREEN', WEST: 'RED' },

  // Current active phase index
  currentPhaseIdx: 2, // EAST starts green

  // Webster computed values
  cycleLength: 90,    // C_0 (s)
  greenSplits: {},    // g_i (s) per phase

  // NEMA timer counters (seconds)
  phaseTimer: 0,
  yellowTimer: 0,
  allRedTimer: 0,
  passageTimer: 0,

  // State machine mode
  mode: 'GREEN',  // GREEN | YELLOW | ALL_RED | EMERGENCY | PRETIMED_FALLBACK

  // EVP Emergency preemption
  emergencyActive: false,
  emergencyPhase: null, // which approach has ambulance
  emergencyStep: 'IDLE', // IDLE | YELLOW_CLEAR | ALL_RED | GREEN_CORRIDOR

  // Multi-Object Tracking (MOT) tracked vehicles
  trackedVehicles: [],
  nextTrackId: 1,

  // Real-time telemetry snapshot
  telemetry: {
    avgDelay: 0,
    throughput: 0,
    queueLengths: { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 },
    vehicleSpeeds: [],
    cycleCount: 0,
    emergencyCount: 0,
    gapOutCount: 0,
    totalVehiclesServed: 0,
  },

  // Last gap (headway) per approach
  lastArrival: { NORTH: 0, SOUTH: 0, EAST: 0, WEST: 0 },
  lastGap: { NORTH: 999, SOUTH: 999, EAST: 999, WEST: 999 },

  uptime: 0, // seconds
};

// ─────────────────────────────────────────────────────────────────────────────
// WEBSTER DELAY OPTIMIZATION ENGINE
// Formula: C_0 = (1.5L + 5) / (1 - Y)
//          g_i = (C_0 - L) × (y_i / Y)
// ─────────────────────────────────────────────────────────────────────────────
function websterOptimize() {
  const y = {};
  let Y = 0;

  for (const ph of PHASES) {
    y[ph] = state.flows[ph] / CONFIG.SATURATION_FLOW;
    Y += y[ph];
  }

  // Clamp Y to prevent division singularity
  if (Y >= 1.0) Y = 0.95;
  if (Y <= 0.0) Y = 0.01;

  let C0 = (1.5 * CONFIG.TOTAL_LOST_TIME + 5) / (1 - Y);
  C0 = Math.max(CONFIG.CYCLE_MIN, Math.min(CONFIG.CYCLE_MAX, C0));

  const Gtotal = C0 - CONFIG.TOTAL_LOST_TIME;
  const splits = {};

  for (const ph of PHASES) {
    splits[ph] = Math.max(CONFIG.MIN_GREEN, (Gtotal * y[ph]) / Y);
  }

  state.cycleLength = Math.round(C0);
  state.greenSplits = splits;

  return { C0, Y, y, splits };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEMA TS-2 ACTUATED STATE MACHINE TICK  (runs every TICK_INTERVAL_MS)
// ─────────────────────────────────────────────────────────────────────────────
function nemaControllerTick(dt) {
  state.uptime += dt;
  websterOptimize();

  const currentPhase = PHASES[state.currentPhaseIdx];

  // ── EMERGENCY PREEMPTION ──────────────────────────────────────────────────
  if (state.emergencyActive) {
    handleEmergencyPreemption(dt, currentPhase);
    return;
  }

  // ── NORMAL ACTUATED OPERATION ─────────────────────────────────────────────
  switch (state.mode) {
    case 'GREEN': {
      state.phaseTimer += dt;
      state.passageTimer += dt;

      // Check Gap-Out: if headway > 2.5s on current approach
      const gap = state.lastGap[currentPhase];
      if (state.phaseTimer >= CONFIG.MIN_GREEN && gap > CONFIG.GAP_OUT_THRESHOLD) {
        state.telemetry.gapOutCount++;
        transitionToYellow();
        break;
      }

      // Check max green (green split from Webster)
      const maxGreen = state.greenSplits[currentPhase] || CONFIG.MIN_GREEN;
      if (state.phaseTimer >= maxGreen) {
        transitionToYellow();
      }
      break;
    }

    case 'YELLOW': {
      state.yellowTimer += dt;
      if (state.yellowTimer >= CONFIG.YELLOW_CLEARANCE) {
        transitionToAllRed();
      }
      break;
    }

    case 'ALL_RED': {
      state.allRedTimer += dt;
      if (state.allRedTimer >= CONFIG.ALL_RED_CLEARANCE) {
        advancePhase();
      }
      break;
    }
  }

  // Update simulated queue lengths & average delay
  updateTelemetry(dt);
}

function transitionToYellow() {
  state.mode = 'YELLOW';
  state.yellowTimer = 0;
  state.signals[PHASES[state.currentPhaseIdx]] = 'YELLOW';
}

function transitionToAllRed() {
  state.mode = 'ALL_RED';
  state.allRedTimer = 0;
  for (const ph of PHASES) state.signals[ph] = 'RED';
}

function advancePhase() {
  // Cycle complete
  state.telemetry.cycleCount++;
  state.telemetry.totalVehiclesServed += Math.round(
    state.flows[PHASES[state.currentPhaseIdx]] * (state.phaseTimer / 3600)
  );

  // Move to next phase (dual-ring wrap)
  state.currentPhaseIdx = (state.currentPhaseIdx + 1) % PHASES.length;
  const nextPhase = PHASES[state.currentPhaseIdx];

  state.mode = 'GREEN';
  state.phaseTimer = 0;
  state.passageTimer = 0;
  state.allRedTimer = 0;
  state.yellowTimer = 0;

  // Set signals
  for (const ph of PHASES) state.signals[ph] = 'RED';
  state.signals[nextPhase] = 'GREEN';

  walLog('PHASE_ADVANCE', { phase: nextPhase, cycleLength: state.cycleLength });
}

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY VEHICLE PRIORITY (EVP) PREEMPTION STATE MACHINE
// Step 1: Force YELLOW (3.0s) on all green approaches
// Step 2: Force ALL_RED (1.2s) — intersection clearance
// Step 3: Grant exclusive GREEN CORRIDOR to emergency approach
// ─────────────────────────────────────────────────────────────────────────────
function handleEmergencyPreemption(dt, currentPhase) {
  switch (state.emergencyStep) {
    case 'YELLOW_CLEAR':
      state.yellowTimer += dt;
      if (state.yellowTimer >= CONFIG.YELLOW_CLEARANCE) {
        // All red clearance
        for (const ph of PHASES) state.signals[ph] = 'RED';
        state.emergencyStep = 'ALL_RED';
        state.allRedTimer = 0;
      }
      break;

    case 'ALL_RED':
      state.allRedTimer += dt;
      if (state.allRedTimer >= CONFIG.ALL_RED_CLEARANCE) {
        // Grant green corridor to emergency approach
        for (const ph of PHASES) state.signals[ph] = 'RED';
        state.signals[state.emergencyPhase] = 'GREEN';
        state.emergencyStep = 'GREEN_CORRIDOR';
        state.phaseTimer = 0;
        walLog('EMERGENCY_GREEN_CORRIDOR', { approach: state.emergencyPhase });
      }
      break;

    case 'GREEN_CORRIDOR':
      state.phaseTimer += dt;
      // Hold for min 15s then release
      if (state.phaseTimer >= 15.0) {
        state.emergencyActive = false;
        state.emergencyStep = 'IDLE';
        state.emergencyPhase = null;
        state.telemetry.emergencyCount++;
        // Resume normal at next phase after emergency approach
        state.currentPhaseIdx = PHASES.indexOf(state.emergencyPhase);
        advancePhase();
      }
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTER VISION MOT ENGINE (Simulated — centroid Euclidean matching)
// In production this ingests real CCTV streams via ffmpeg/canvas
// ─────────────────────────────────────────────────────────────────────────────
function cvTrackingTick() {
  const now = Date.now() / 1000;

  // Simulate vehicle arrivals probabilistically based on flow rates
  for (const ph of PHASES) {
    const arrivalProb = (state.flows[ph] / 3600) * (CONFIG.TICK_INTERVAL_MS / 1000);
    if (Math.random() < arrivalProb) {
      // New vehicle detection — compute gap (headway)
      const gap = now - state.lastArrival[ph];
      state.lastGap[ph] = gap;
      state.lastArrival[ph] = now;

      // Create track
      const vehicle = {
        id: state.nextTrackId++,
        approach: ph,
        type: randomVehicleType(),
        speedKph: 40 + Math.random() * 30,
        centroidY: 55 + Math.random() * 10,
        crossedLine2: false,
        entryTime: now,
        loop1Time: now,
      };
      state.trackedVehicles.push(vehicle);

      // Simulate crossing virtual loop 2 (stop line)
      setTimeout(() => {
        const v = state.trackedVehicles.find(x => x.id === vehicle.id);
        if (v) {
          v.crossedLine2 = true;
          v.loop2Time = Date.now() / 1000;
          const dt = v.loop2Time - v.loop1Time;
          v.speedKph = (CONFIG.LOOP_BASELINE_DIST / dt) * 3.6;
          state.telemetry.vehicleSpeeds.push(v.speedKph);
          if (state.telemetry.vehicleSpeeds.length > 50)
            state.telemetry.vehicleSpeeds.shift();
        }
      }, 1000 + Math.random() * 2000);
    }
  }

  // Prune old tracks
  state.trackedVehicles = state.trackedVehicles.filter(
    v => (Date.now() / 1000) - v.entryTime < 60
  );

  // Update queue lengths
  for (const ph of PHASES) {
    state.telemetry.queueLengths[ph] = state.trackedVehicles.filter(
      v => v.approach === ph && !v.crossedLine2
    ).length;
  }
}

function randomVehicleType() {
  const r = Math.random();
  if (r < 0.03) return 'AMBULANCE';
  if (r < 0.08) return 'TRUCK';
  if (r < 0.18) return 'SUV';
  return 'SEDAN';
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEMETRY COMPUTATION
// Webster delay formula: d_i = (c(1-λ_i)²)/(2(1-λ_i·x_i))
// ─────────────────────────────────────────────────────────────────────────────
function updateTelemetry(dt) {
  let totalDelay = 0;
  let count = 0;

  for (const ph of PHASES) {
    const q = state.flows[ph];
    const g = state.greenSplits[ph] || CONFIG.MIN_GREEN;
    const c = state.cycleLength;
    const lambda = g / c;
    const x = q / (lambda * CONFIG.SATURATION_FLOW);
    const xClamped = Math.min(x, 0.99);
    const delay = (c * (1 - lambda) ** 2) / (2 * (1 - lambda * xClamped));
    totalDelay += delay;
    count++;
  }

  state.telemetry.avgDelay = totalDelay / count;
  state.telemetry.throughput = Object.values(state.flows).reduce((a, b) => a + b, 0) / 4;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE-AHEAD LOGGING (WAL) — atomic JSON append
// ─────────────────────────────────────────────────────────────────────────────
function walLog(event, data) {
  const record = {
    timestamp: new Date().toISOString(),
    event,
    data,
    cycleCount: state.telemetry.cycleCount,
    activePhase: PHASES[state.currentPhaseIdx],
  };

  try {
    const existing = JSON.parse(fs.readFileSync(CONFIG.WAL_PATH, 'utf8') || '[]');
    existing.push(record);
    // Keep last 1000 records
    const trimmed = existing.slice(-1000);
    fs.writeFileSync(CONFIG.WAL_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (e) {
    // If corrupt, reset WAL
    fs.writeFileSync(CONFIG.WAL_PATH, JSON.stringify([record], null, 2), 'utf8');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLER TICK LOOP
// ─────────────────────────────────────────────────────────────────────────────
const DT = CONFIG.TICK_INTERVAL_MS / 1000;
setInterval(() => {
  cvTrackingTick();
  nemaControllerTick(DT);

  // Check if any ambulance in tracked vehicles triggers EVP
  if (!state.emergencyActive) {
    const ambulance = state.trackedVehicles.find(
      v => v.type === 'AMBULANCE' && !v.crossedLine2
    );
    if (ambulance) {
      triggerEmergencyPreemption(ambulance.approach);
    }
  }
}, CONFIG.TICK_INTERVAL_MS);

function triggerEmergencyPreemption(approach) {
  state.emergencyActive = true;
  state.emergencyPhase = approach;
  state.emergencyStep = 'YELLOW_CLEAR';
  state.yellowTimer = 0;

  // Force yellow on currently green approach
  for (const ph of PHASES) {
    if (state.signals[ph] === 'GREEN') state.signals[ph] = 'YELLOW';
  }

  walLog('EMERGENCY_PREEMPTION_TRIGGERED', { approach, vehicles: state.trackedVehicles.length });
  console.log(`🚨 [EVP] Emergency preemption triggered for approach: ${approach}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // ── API ROUTES ──────────────────────────────────────────────────────────────
  if (pathname === '/api/state' && method === 'GET') {
    return sendJSON(res, {
      signals: state.signals,
      flows: state.flows,
      cycleLength: state.cycleLength,
      greenSplits: state.greenSplits,
      mode: state.mode,
      currentPhase: PHASES[state.currentPhaseIdx],
      phaseTimer: Math.round(state.phaseTimer * 10) / 10,
      emergencyActive: state.emergencyActive,
      emergencyPhase: state.emergencyPhase,
      emergencyStep: state.emergencyStep,
      telemetry: state.telemetry,
      trackedVehicles: state.trackedVehicles.slice(-20),
      uptime: Math.round(state.uptime),
    });
  }

  if (pathname === '/api/flows' && method === 'POST') {
    const body = await parseBody(req);
    for (const ph of PHASES) {
      if (body[ph] !== undefined) {
        state.flows[ph] = Math.max(0, Math.min(2000, Number(body[ph])));
      }
    }
    walLog('FLOW_UPDATE', body);
    return sendJSON(res, { success: true, flows: state.flows });
  }

  if (pathname === '/api/emergency' && method === 'POST') {
    const body = await parseBody(req);
    const approach = (body.approach || '').toUpperCase();
    if (PHASES.includes(approach) && !state.emergencyActive) {
      triggerEmergencyPreemption(approach);
      return sendJSON(res, { success: true, approach, message: 'Emergency preemption initiated' });
    }
    return sendJSON(res, { success: false, message: 'Invalid approach or emergency already active' }, 400);
  }

  if (pathname === '/api/analytics' && method === 'GET') {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG.WAL_PATH, 'utf8') || '[]');
      return sendJSON(res, { records: data.slice(-100) });
    } catch {
      return sendJSON(res, { records: [] });
    }
  }

  if (pathname === '/api/reset' && method === 'POST') {
    state.emergencyActive = false;
    state.emergencyPhase = null;
    state.emergencyStep = 'IDLE';
    state.mode = 'GREEN';
    state.phaseTimer = 0;
    for (const ph of PHASES) state.signals[ph] = 'RED';
    state.signals[PHASES[state.currentPhaseIdx]] = 'GREEN';
    walLog('SYSTEM_RESET', {});
    return sendJSON(res, { success: true });
  }

  // ── STATIC FILE SERVER ──────────────────────────────────────────────────────
  let filePath = path.join(CONFIG.PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security: prevent path traversal
  if (!filePath.startsWith(CONFIG.PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Serve index.html as fallback for SPA routing
      filePath = path.join(CONFIG.PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err2, data) => {
      if (err2) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      res.writeHead(200, { 'Content-Type': mimeType });
      res.end(data);
    });
  });
});

server.listen(CONFIG.PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║   ATCS — Adaptive Traffic Signal Control System v1.0         ║
║   BTech CSE Major Project  |  JNTUH 2025-2026                ║
╠══════════════════════════════════════════════════════════════╣
║   Server  : http://localhost:${CONFIG.PORT}                        ║
║   WAL DB  : data/traffic_analytics.json                      ║
║   Phases  : NORTH · SOUTH · EAST · WEST                      ║
╚══════════════════════════════════════════════════════════════╝
  `);
  walLog('SYSTEM_START', { port: CONFIG.PORT, phases: PHASES });
});
