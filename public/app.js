/**
 * ATCS — TMC Web Console  |  app.js  v3.0
 * Matches redesigned professional UI
 */
'use strict';

// ─── STATE ────────────────────────────────────────────────────────────────────
const PHASES = ['NORTH','SOUTH','EAST','WEST'];

const state = {
  signals:     { NORTH:'RED', SOUTH:'RED', EAST:'GREEN', WEST:'RED' },
  flows:       { NORTH:720, SOUTH:540, EAST:900, WEST:660 },
  greenSplits: { NORTH:18, SOUTH:14, EAST:22, WEST:16 },
  cycleLength: 90,
  mode:        'GREEN',
  currentPhase:'EAST',
  phaseTimer:  0,
  emergencyActive: false,
  emergencyPhase:  null,
  emergencyStep:   'IDLE',
  telemetry: {
    avgDelay:0, throughput:0,
    queueLengths:{NORTH:0,SOUTH:0,EAST:0,WEST:0},
    vehicleSpeeds:[], cycleCount:0, emergencyCount:0,
    gapOutCount:0, totalVehiclesServed:0,
  },
  trackedVehicles: [],
  uptime: 0,
  walRecords: [],
  canvasVehicles: [],
  nextVId: 1,
};

// ─── CANVAS ───────────────────────────────────────────────────────────────────
const mainCanvas = document.getElementById('intersectionCanvas');
const ctx        = mainCanvas.getContext('2d');
const cctvCanvas = document.getElementById('cctvCanvas');
const cctv       = cctvCanvas.getContext('2d');

const W = mainCanvas.width;   // 600
const H = mainCanvas.height;  // 600
const CX = W / 2, CY = H / 2;
const RW = 130;  // road width px (wider = more realistic)
const LW = 38;   // lane width

// Stop lines (where vehicles queue before the box)
const STOP = {
  NORTH: CY - RW/2 - 14,
  SOUTH: CY + RW/2 + 14,
  EAST:  CX + RW/2 + 14,
  WEST:  CX - RW/2 - 14,
};

// Lane X/Y centres for each approach's incoming traffic
const LANE = {
  NORTH: CX - LW * 0.55,   // incoming going south → left lane
  SOUTH: CX + LW * 0.55,   // incoming going north → right lane
  EAST:  CY - LW * 0.55,   // incoming going west  → upper lane
  WEST:  CY + LW * 0.55,   // incoming going east  → lower lane
};

// ─── CHARTS ───────────────────────────────────────────────────────────────────
const chartBase = {
  responsive:true, maintainAspectRatio:false,
  animation:{duration:300},
  plugins:{legend:{display:false}},
};

const delayData = Array(40).fill(0);
const delayChart = new Chart(document.getElementById('delayChart'), {
  type:'line',
  data:{
    labels: Array(40).fill(''),
    datasets:[{
      data: delayData, borderColor:'#3b82f6', borderWidth:1.5,
      fill:true, backgroundColor:'rgba(59,130,246,0.06)',
      tension:0.35, pointRadius:0,
    }]
  },
  options:{
    ...chartBase,
    scales:{
      x:{display:false},
      y:{grid:{color:'#1c2333'}, ticks:{color:'#5a6682',font:{size:9}}, min:0}
    }
  }
});

const flowChart = new Chart(document.getElementById('flowChart'), {
  type:'bar',
  data:{
    labels: PHASES,
    datasets:[{
      data:[720,540,900,660],
      backgroundColor:['rgba(59,130,246,0.6)','rgba(20,184,166,0.6)','rgba(245,158,11,0.6)','rgba(139,92,246,0.6)'],
      borderColor:['#3b82f6','#14b8a6','#f59e0b','#8b5cf6'],
      borderWidth:1, borderRadius:3,
    }]
  },
  options:{
    ...chartBase,
    scales:{
      x:{grid:{display:false}, ticks:{color:'#5a6682',font:{size:10}}},
      y:{grid:{color:'#1c2333'}, ticks:{color:'#5a6682',font:{size:9}}, min:0, max:1800}
    }
  }
});

// Cycle ring canvas
const ringCanvas = document.getElementById('cycleRingCanvas');
const ringCtx    = ringCanvas.getContext('2d');

function drawCycleRing(cycleLen, phaseTimer) {
  const r = ringCanvas.width;
  ringCtx.clearRect(0, 0, r, r);
  const cx = r/2, cy = r/2, radius = r/2 - 8;

  // Background track
  ringCtx.beginPath();
  ringCtx.arc(cx, cy, radius, 0, Math.PI*2);
  ringCtx.strokeStyle = '#2a3347';
  ringCtx.lineWidth = 6;
  ringCtx.stroke();

  // Progress arc
  const pct = Math.min(phaseTimer / Math.max(cycleLen, 1), 1);
  const startAngle = -Math.PI/2;
  ringCtx.beginPath();
  ringCtx.arc(cx, cy, radius, startAngle, startAngle + pct * Math.PI * 2);
  ringCtx.strokeStyle = '#22c55e';
  ringCtx.lineWidth = 6;
  ringCtx.lineCap = 'round';
  ringCtx.stroke();
}

// ─── API ──────────────────────────────────────────────────────────────────────
async function fetchState() {
  try {
    const r = await fetch('/api/state');
    const d = await r.json();
    Object.assign(state, d);
  } catch {}
}
async function fetchAnalytics() {
  try {
    const r = await fetch('/api/analytics');
    const d = await r.json();
    state.walRecords = d.records || [];
  } catch {}
}
async function pushFlows() {
  try {
    await fetch('/api/flows', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(state.flows),
    });
  } catch {}
}
window.resetSystem = async () => {
  try { await fetch('/api/reset', {method:'POST'}); } catch {}
};
window.updateFlowSlider = (ph, val) => {
  state.flows[ph] = parseInt(val);
  document.getElementById(`flowVal${ph}`).textContent = val;
  document.getElementById(`sat${ph}`).style.width = `${(val/1800*100).toFixed(1)}%`;
};
window.pushFlows = pushFlows;

// ─── EMERGENCY MODAL ──────────────────────────────────────────────────────────
const APPROACH_HINTS = {
  NORTH:'Traffic from North, travelling South',
  SOUTH:'Traffic from South, travelling North',
  EAST: 'Traffic from East, travelling West',
  WEST: 'Traffic from West, travelling East',
};

window.openEvModal = function(approach) {
  document.getElementById('evModalApproach').value = approach;
  document.getElementById('evApproachLabel').textContent = approach;
  document.getElementById('evApproachHint').textContent  = APPROACH_HINTS[approach] || '';
  document.getElementById('evModal').classList.remove('hidden');
  selectEvType('AMBULANCE');
};
window.closeEvModal = function() {
  document.getElementById('evModal').classList.add('hidden');
};
window.selectEvType = function(type) {
  document.getElementById('evTypeSelect').value = type;
  ['AMBULANCE','FIRETRUCK'].forEach(t => {
    const el = document.getElementById(`vs${t.charAt(0)+t.slice(1).toLowerCase()}`);
    if (el) el.classList.toggle('selected', t === type);
    const radio = document.getElementById(`radio${t.charAt(0)+t.slice(1).toLowerCase()}`);
    if (radio) radio.innerHTML = t === type ? '<div class="vs-radio-dot"></div>' : '';
  });
};
window.dispatchEvVehicle = async function() {
  const approach = document.getElementById('evModalApproach').value;
  const type     = document.getElementById('evTypeSelect').value;
  closeEvModal();
  try {
    await fetch('/api/emergency', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({approach}),
    });
  } catch {}
  spawnEmergencyVehicle(approach, type);
};

// ─── VEHICLE SPAWNING ─────────────────────────────────────────────────────────
const SPAWN = {
  NORTH:{ x:()=>LANE.NORTH, y:()=> -36, dx: 0, dy: 1,  axis:'y', stopFn:(v)=>STOP.NORTH - v.h/2 },
  SOUTH:{ x:()=>LANE.SOUTH, y:()=> H+36, dx: 0, dy:-1,  axis:'y', stopFn:(v)=>STOP.SOUTH + v.h/2 },
  EAST: { x:()=> W+36, y:()=>LANE.EAST,  dx:-1, dy: 0,  axis:'x', stopFn:(v)=>STOP.EAST  + v.w/2 },
  WEST: { x:()=> -36,  y:()=>LANE.WEST,  dx: 1, dy: 0,  axis:'x', stopFn:(v)=>STOP.WEST  - v.w/2 },
};

const VDIMS = {
  SEDAN:    {w:16,h:30}, SUV:{w:18,h:34}, TRUCK:{w:20,h:46},
  AMBULANCE:{w:18,h:36}, FIRETRUCK:{w:22,h:52},
};
const VCOLORS = ['#4d7ab5','#5a9e7a','#7c6d9e','#a0a0b0','#3a7ca5','#5a8a6a'];

function randomType() {
  const r = Math.random();
  return r<0.07?'TRUCK': r<0.22?'SUV': 'SEDAN';
}

function spawnNormal() {
  for (const ph of PHASES) {
    const prob = (state.flows[ph]/3600)*(1/30)*0.55;
    if (Math.random() > prob) continue;
    const sp = SPAWN[ph];
    const type = randomType();
    const dims = VDIMS[type];
    // Min spacing check
    const near = state.canvasVehicles.filter(v=>v.ph===ph && !v.cleared);
    const minDist = dims.h + 20;
    const tooClose = near.some(v => {
      const d = Math.hypot(v.x - sp.x(), v.y - sp.y());
      return d < minDist;
    });
    if (tooClose) continue;

    state.canvasVehicles.push({
      id: state.nextVId++, ph, type,
      x: sp.x() + (Math.random()-0.5)*3,
      y: sp.y() + (Math.random()-0.5)*3,
      dx: sp.dx, dy: sp.dy, axis: sp.axis,
      w: dims.w, h: dims.h,
      speed: 1.3 + Math.random()*0.5,
      color: VCOLORS[Math.floor(Math.random()*VCOLORS.length)],
      isEV: false, stopped: false, cleared: false,
      stopPos: sp.stopFn({w:dims.w,h:dims.h}),
    });
  }
}

function spawnEmergencyVehicle(ph, type) {
  const sp   = SPAWN[ph];
  const dims = VDIMS[type] || VDIMS.AMBULANCE;
  // remove previous EV on same approach
  state.canvasVehicles = state.canvasVehicles.filter(v=>!(v.isEV && v.ph===ph));
  state.canvasVehicles.push({
    id: state.nextVId++, ph, type,
    x: sp.x(), y: sp.y(),
    dx: sp.dx, dy: sp.dy, axis: sp.axis,
    w: dims.w, h: dims.h,
    speed: 3.0, // fast
    color: type==='FIRETRUCK'?'#c0392b':'#ecf0f1',
    isEV: true, stopped: false, cleared: false,
    stopPos: sp.stopFn({w:dims.w,h:dims.h}),
    sirenT: 0,
  });
}

// ─── VEHICLE PHYSICS ──────────────────────────────────────────────────────────
function updateVehicles() {
  spawnNormal();

  for (const v of state.canvasVehicles) {
    if (v.cleared) continue;

    const sig = state.signals[v.ph];
    const sp  = SPAWN[v.ph];

    if (v.isEV) {
      // Emergency vehicles always go — no stopping
      v.x += v.dx * v.speed;
      v.y += v.dy * v.speed;
      v.sirenT = (v.sirenT||0) + 0.12;
    } else {
      // Check if should stop at red/yellow (before intersection box)
      const shouldStop = (sig==='RED'||sig==='YELLOW') && !inBox(v);
      if (shouldStop && atStop(v)) {
        // Already at stop line — just maintain position, allow stacking
        stackBehind(v);
        continue;
      }
      v.stopped = false;

      // Follow-the-leader: slow if vehicle ahead is close
      const ahead = getAhead(v);
      if (ahead) {
        const gap = gapAhead(v, ahead);
        if (gap < ahead.h/2 + 14) { v.stopped = true; stackBehind(v); continue; }
        const factor = Math.min(1, gap/55);
        v.x += v.dx * v.speed * factor;
        v.y += v.dy * v.speed * factor;
      } else {
        v.x += v.dx * v.speed;
        v.y += v.dy * v.speed;
      }
    }

    // Remove when off screen
    if (v.x < -80 || v.x > W+80 || v.y < -80 || v.y > H+80) v.cleared = true;
  }

  state.canvasVehicles = state.canvasVehicles.filter(v=>!v.cleared).slice(-100);
}

function atStop(v) {
  if (v.dy > 0)  return v.y + v.h/2 >= v.stopPos;
  if (v.dy < 0)  return v.y - v.h/2 <= v.stopPos;
  if (v.dx < 0)  return v.x - v.w/2 <= v.stopPos;
  if (v.dx > 0)  return v.x + v.w/2 >= v.stopPos;
  return false;
}

function inBox(v) {
  return v.x > CX-RW/2 && v.x < CX+RW/2 && v.y > CY-RW/2 && v.y < CY+RW/2;
}

function getAhead(v) {
  let best=null, bestD=9999;
  for (const u of state.canvasVehicles) {
    if (u===v || u.cleared || u.ph!==v.ph) continue;
    const d = gapAhead(v,u);
    if (d>0 && d<bestD) { bestD=d; best=u; }
  }
  return best;
}

function gapAhead(v,u) {
  if (v.dy>0)  return u.y - v.y;
  if (v.dy<0)  return v.y - u.y;
  if (v.dx<0)  return v.x - u.x;
  if (v.dx>0)  return u.x - v.x;
  return 9999;
}

function stackBehind(v) {
  // Snap to stop and push back if overlapping anything
  for (const u of state.canvasVehicles) {
    if (u===v||u.cleared||u.ph!==v.ph||u===v) continue;
    const gap = gapAhead(v,u);
    const need = u.h/2 + v.h/2 + 8;
    if (gap>0 && gap<need) {
      if (v.dy>0) v.y = u.y - need;
      if (v.dy<0) v.y = u.y + need;
      if (v.dx<0) v.x = u.x + need;
      if (v.dx>0) v.x = u.x - need;
    }
  }
}

// ─── INTERSECTION RENDERER ────────────────────────────────────────────────────
function draw() {
  ctx.clearRect(0,0,W,H);

  drawGround();
  drawRoads();
  drawMarkings();
  drawCrosswalk();
  drawVehicles();
  drawApproachArrows();
}

function drawGround() {
  ctx.fillStyle = '#090d14';
  ctx.fillRect(0,0,W,H);

  // City block texture
  const quads = [
    [0,0,CX-RW/2,CY-RW/2],
    [CX+RW/2,0,W-(CX+RW/2),CY-RW/2],
    [0,CY+RW/2,CX-RW/2,H-(CY+RW/2)],
    [CX+RW/2,CY+RW/2,W-(CX+RW/2),H-(CY+RW/2)],
  ];
  for (const [x,y,w,h] of quads) {
    ctx.fillStyle = '#0b1017';
    ctx.fillRect(x,y,w,h);
    // Building footprints
    const margin = 8;
    for (let bx = x+margin; bx < x+w-40; bx+=44) {
      for (let by = y+margin; by < y+h-40; by+=44) {
        const bw = 28 + Math.random()*8|0;
        const bh = 28 + Math.random()*8|0;
        ctx.fillStyle = '#0f1622';
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = '#182030';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bw, bh);
        // Lit windows
        for (let wx=bx+4; wx<bx+bw-8; wx+=8) {
          for (let wy=by+4; wy<by+bh-8; wy+=8) {
            ctx.fillStyle = Math.random()>0.55 ? '#1a2d45' : '#0a1120';
            ctx.fillRect(wx,wy,5,5);
          }
        }
      }
    }
  }
}

function drawRoads() {
  // Road surface
  ctx.fillStyle = '#151e2c';
  ctx.fillRect(CX-RW/2, 0, RW, H);      // N-S
  ctx.fillRect(0, CY-RW/2, W, RW);       // E-W

  // Box junction
  ctx.fillStyle = '#111825';
  ctx.fillRect(CX-RW/2, CY-RW/2, RW, RW);

  // Road edge kerbs
  ctx.strokeStyle = '#1e2d42';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(CX-RW/2, 0, RW, H);
  ctx.strokeRect(0, CY-RW/2, W, RW);

  // Center line (yellow dashes)
  ctx.save();
  ctx.setLineDash([18,12]);
  ctx.strokeStyle = 'rgba(245,158,11,0.35)';
  ctx.lineWidth = 1.5;
  // N-S center
  ctx.beginPath(); ctx.moveTo(CX,0); ctx.lineTo(CX,CY-RW/2);
  ctx.moveTo(CX,CY+RW/2); ctx.lineTo(CX,H); ctx.stroke();
  // E-W center
  ctx.beginPath(); ctx.moveTo(0,CY); ctx.lineTo(CX-RW/2,CY);
  ctx.moveTo(CX+RW/2,CY); ctx.lineTo(W,CY); ctx.stroke();
  ctx.restore();

  // Lane lines (white dashes, inner lanes)
  ctx.save();
  ctx.setLineDash([10,14]);
  ctx.strokeStyle = 'rgba(180,200,220,0.12)';
  ctx.lineWidth = 1;
  // N-S additional lane
  ctx.beginPath(); ctx.moveTo(CX-LW, 0); ctx.lineTo(CX-LW, CY-RW/2);
  ctx.moveTo(CX-LW, CY+RW/2); ctx.lineTo(CX-LW, H);
  ctx.moveTo(CX+LW, 0); ctx.lineTo(CX+LW, CY-RW/2);
  ctx.moveTo(CX+LW, CY+RW/2); ctx.lineTo(CX+LW, H);
  // E-W
  ctx.moveTo(0,CY-LW); ctx.lineTo(CX-RW/2,CY-LW);
  ctx.moveTo(CX+RW/2,CY-LW); ctx.lineTo(W,CY-LW);
  ctx.moveTo(0,CY+LW); ctx.lineTo(CX-RW/2,CY+LW);
  ctx.moveTo(CX+RW/2,CY+LW); ctx.lineTo(W,CY+LW);
  ctx.stroke();
  ctx.restore();
}

function drawMarkings() {
  // Stop lines
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  // NORTH stop (traffic going south)
  ctx.moveTo(CX-RW/2+2, STOP.NORTH); ctx.lineTo(CX, STOP.NORTH);
  // SOUTH stop (traffic going north)
  ctx.moveTo(CX, STOP.SOUTH); ctx.lineTo(CX+RW/2-2, STOP.SOUTH);
  // EAST stop (traffic going west)
  ctx.moveTo(STOP.EAST, CY-RW/2+2); ctx.lineTo(STOP.EAST, CY);
  // WEST stop (traffic going east)
  ctx.moveTo(STOP.WEST, CY); ctx.lineTo(STOP.WEST, CY+RW/2-2);
  ctx.stroke();

  // Virtual inductive loop lines
  const LOOP = 70;
  ctx.save();
  ctx.setLineDash([5,5]);
  ctx.strokeStyle = 'rgba(34,197,94,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CX-RW/2+2, STOP.NORTH-LOOP); ctx.lineTo(CX-2, STOP.NORTH-LOOP);
  ctx.moveTo(CX+2, STOP.SOUTH+LOOP); ctx.lineTo(CX+RW/2-2, STOP.SOUTH+LOOP);
  ctx.moveTo(STOP.EAST+LOOP, CY-RW/2+2); ctx.lineTo(STOP.EAST+LOOP, CY-2);
  ctx.moveTo(STOP.WEST-LOOP, CY+2); ctx.lineTo(STOP.WEST-LOOP, CY+RW/2-2);
  ctx.stroke();
  ctx.restore();

  // Loop label
  ctx.fillStyle = 'rgba(34,197,94,0.4)';
  ctx.font = '8px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('VDL-1', CX+4, STOP.NORTH-LOOP-3);
}

function drawCrosswalk() {
  ctx.fillStyle = 'rgba(220,230,250,0.04)';
  // North crosswalk
  for (let i=0;i<6;i++) {
    ctx.fillRect(CX-RW/2+4+i*(RW/2-4)/6*1.8, STOP.NORTH+2, (RW/2-4)/6+1, 10);
  }
  // South crosswalk
  for (let i=0;i<6;i++) {
    ctx.fillRect(CX+4+i*(RW/2-4)/6*1.8, STOP.SOUTH-12, (RW/2-4)/6+1, 10);
  }
}

function drawVehicles() {
  const normal = state.canvasVehicles.filter(v=>!v.isEV);
  const evs    = state.canvasVehicles.filter(v=> v.isEV);
  for (const v of [...normal,...evs]) renderVehicle(v);
}

function renderVehicle(v) {
  ctx.save();
  ctx.translate(v.x, v.y);
  // Rotate so front faces direction of travel
  if      (v.dy>0)  ctx.rotate(0);
  else if (v.dy<0)  ctx.rotate(Math.PI);
  else if (v.dx<0)  ctx.rotate(-Math.PI/2);
  else if (v.dx>0)  ctx.rotate( Math.PI/2);

  if (v.isEV) drawEV(ctx, v);
  else        drawCar(ctx, v);
  ctx.restore();
}

function drawCar(ctx, v) {
  const {w,h,color,stopped,type} = v;
  const hw=w/2, hh=h/2;

  // Drop shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
  ctx.fillStyle = adjustBrightness(color, stopped ? 0.6 : 1);
  roundedRect(ctx, -hw, -hh, w, h, 4);
  ctx.fill();
  ctx.restore();

  // Roof panel
  ctx.fillStyle = adjustBrightness(color, stopped ? 0.5 : 0.88);
  roundedRect(ctx, -hw+3, -hh+6, w-6, h*0.52, 3);
  ctx.fill();

  // Windscreen (front = top of coord system)
  ctx.fillStyle = 'rgba(160,210,255,0.22)';
  ctx.fillRect(-hw+4, -hh+4, w-8, h*0.27);

  // Rear window
  ctx.fillStyle = 'rgba(120,170,210,0.15)';
  ctx.fillRect(-hw+4, hh-h*0.20-4, w-8, h*0.18);

  // Headlights (front)
  ctx.fillStyle = stopped ? '#888' : '#fffde7';
  ctx.beginPath(); ctx.arc(-hw+5, -hh+6, 3, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( hw-5, -hh+6, 3, 0, Math.PI*2); ctx.fill();

  // Tail lights (rear)
  ctx.fillStyle = stopped ? '#cc1111' : '#881111';
  ctx.fillRect(-hw+3, hh-7, 6, 5);
  ctx.fillRect( hw-9, hh-7, 6, 5);

  // Truck cabin divider
  if (type==='TRUCK') {
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-hw, -hh+h*0.3); ctx.lineTo(hw, -hh+h*0.3); ctx.stroke();
  }
}

function drawEV(ctx, v) {
  const {w,h,type,sirenT} = v;
  const hw=w/2, hh=h/2;
  const isAmb = type==='AMBULANCE';
  const baseCol = isAmb ? '#e8edf2' : '#cc2200';
  const stripe  = isAmb ? '#e53935' : '#e8b600';

  // Shadow
  ctx.save();
  ctx.shadowColor = isAmb ? 'rgba(229,57,53,0.5)' : 'rgba(230,100,0,0.5)';
  ctx.shadowBlur = 22;
  ctx.fillStyle = baseCol;
  roundedRect(ctx,-hw,-hh,w,h,5); ctx.fill();
  ctx.restore();

  // Body
  ctx.fillStyle = baseCol;
  roundedRect(ctx,-hw,-hh,w,h,5); ctx.fill();

  // Stripe band
  ctx.fillStyle = stripe;
  ctx.fillRect(-hw, -h*0.10, w, h*0.20);

  // Windshield
  ctx.fillStyle = 'rgba(60,130,200,0.3)';
  ctx.fillRect(-hw+3, -hh+4, w-6, h*0.25);

  // Headlights (brighter than normal)
  ctx.fillStyle = '#fffde7';
  ctx.shadowColor='#fff'; ctx.shadowBlur=10;
  ctx.beginPath(); ctx.arc(-hw+4, -hh+6, 3.5, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc( hw-4, -hh+6, 3.5, 0, Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;

  if (isAmb) {
    // Red cross
    ctx.fillStyle = '#e53935';
    ctx.fillRect(-2, h*0.08, 4, 16);
    ctx.fillRect(-8, h*0.08+6, 16, 4);
  } else {
    // Hose reel lines
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-hw+4, h*0.05); ctx.lineTo(hw-4, h*0.05);
    ctx.moveTo(-hw+4, h*0.22); ctx.lineTo(hw-4, h*0.22);
    ctx.stroke();
  }

  // Siren lights on roof — alternating red/blue flash
  const tick = Math.floor(Date.now()/180)%2;
  ctx.save();
  // Left siren
  ctx.shadowColor = tick===0?'#ef4444':'#3b82f6';
  ctx.shadowBlur  = 20;
  ctx.fillStyle   = tick===0?'#ef4444':'#3b82f6';
  roundedRect(ctx, -hw+2, -hh-8, w/2-2, 7, 2); ctx.fill();
  // Right siren
  ctx.shadowColor = tick===1?'#ef4444':'#3b82f6';
  ctx.shadowBlur  = 20;
  ctx.fillStyle   = tick===1?'#ef4444':'#3b82f6';
  roundedRect(ctx, 1, -hh-8, w/2-2, 7, 2); ctx.fill();
  ctx.restore();

  // Speed lines behind (motion blur feel)
  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  for (let i=0;i<4;i++) {
    const ly = hh + 5 + i*7;
    ctx.beginPath();
    ctx.moveTo(-hw+4+i*2, ly); ctx.lineTo(hw-4-i*2, ly);
    ctx.stroke();
  }
  ctx.restore();
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
  ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
  ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
  ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
  ctx.closePath();
}

function adjustBrightness(hex, factor) {
  // Simple hex brightness adjustment
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  const nr = Math.min(255,r*factor)|0;
  const ng = Math.min(255,g*factor)|0;
  const nb = Math.min(255,b*factor)|0;
  return `rgb(${nr},${ng},${nb})`;
}

function drawApproachArrows() {
  ctx.font = 'bold 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  const labels = [
    {t:'N',  x:CX, y:16,   ph:'NORTH'},
    {t:'S',  x:CX, y:H-5,  ph:'SOUTH'},
    {t:'W',  x:18, y:CY+4, ph:'WEST'},
    {t:'E',  x:W-18,y:CY+4,ph:'EAST'},
  ];
  for (const l of labels) {
    const sig = state.signals[l.ph];
    ctx.fillStyle = sig==='GREEN'?'#22c55e': sig==='YELLOW'?'#f59e0b':'#ef4444';
    ctx.fillText(l.t, l.x, l.y);
    // Queue
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.fillStyle = 'rgba(180,200,220,0.4)';
    const q = (state.telemetry.queueLengths||{})[l.ph]||0;
    ctx.fillText(`Q:${q}`, l.x, l.y+12);
    ctx.font = 'bold 11px Inter, sans-serif';
  }
}

// ─── CCTV RENDERER ────────────────────────────────────────────────────────────
let scanY = 0;
function drawCCTV() {
  const cw = cctvCanvas.width, ch = cctvCanvas.height;
  cctv.fillStyle = '#050810';
  cctv.fillRect(0,0,cw,ch);

  // Road footprint projection
  cctv.fillStyle = '#0d1520';
  cctv.fillRect(cw*0.38, 0, cw*0.24, ch);
  cctv.fillRect(0, ch*0.40, cw, ch*0.20);

  // Box
  cctv.fillStyle = '#0a1018';
  cctv.fillRect(cw*0.38, ch*0.40, cw*0.24, ch*0.20);

  // Lane dashes
  cctv.save();
  cctv.setLineDash([6,8]);
  cctv.strokeStyle='rgba(245,158,11,0.2)'; cctv.lineWidth=1;
  cctv.beginPath();
  cctv.moveTo(cw*0.50,0); cctv.lineTo(cw*0.50,ch);
  cctv.moveTo(0,ch*0.50); cctv.lineTo(cw,ch*0.50);
  cctv.stroke();
  cctv.restore();

  // VDL lines
  cctv.save();
  cctv.setLineDash([4,4]);
  cctv.strokeStyle='rgba(34,197,94,0.45)'; cctv.lineWidth=1;
  cctv.beginPath();
  cctv.moveTo(cw*0.38,ch*0.22); cctv.lineTo(cw*0.62,ch*0.22);
  cctv.moveTo(cw*0.38,ch*0.35); cctv.lineTo(cw*0.62,ch*0.35);
  cctv.stroke();
  cctv.restore();

  // Project canvas vehicles to overhead
  for (const v of state.canvasVehicles) {
    if (v.cleared) continue;
    const px = (v.x/W)*cw, py = (v.y/H)*ch;
    if (px<-10||px>cw+10||py<-10||py>ch+10) continue;

    const bw = v.isEV?10:7, bh=v.isEV?16:11;
    cctv.save();
    cctv.translate(px,py);
    if (v.dy!==0) cctv.rotate(v.dy>0?0:Math.PI);
    else cctv.rotate(v.dx>0?Math.PI/2:-Math.PI/2);

    cctv.shadowColor = v.isEV?'rgba(239,68,68,0.6)':'rgba(0,0,0,0.4)';
    cctv.shadowBlur = v.isEV?8:4;
    cctv.fillStyle = v.isEV?(v.type==='AMBULANCE'?'#e8edf2':'#cc2200'):v.color||'#4a7ab5';
    cctv.fillRect(-bw/2,-bh/2,bw,bh);
    cctv.restore();

    // Tracking box
    cctv.strokeStyle = v.isEV?'rgba(239,68,68,0.9)':'rgba(34,197,94,0.45)';
    cctv.lineWidth = v.isEV?1.5:0.7;
    cctv.strokeRect(px-bw/2-2,py-bh/2-2,bw+4,bh+4);

    // ID tag
    cctv.fillStyle = v.isEV?'#ef4444':'rgba(34,197,94,0.6)';
    cctv.font='6px JetBrains Mono,monospace'; cctv.textAlign='center';
    cctv.fillText('#'+v.id, px, py-bh/2-4);
  }

  // OSD
  cctv.fillStyle='rgba(34,197,94,0.7)'; cctv.font='7px JetBrains Mono,monospace';
  cctv.textAlign='left';
  cctv.fillText('CAM-N1 | OVERHEAD', 4, 10);
  cctv.fillStyle='rgba(34,197,94,0.35)';
  cctv.fillText(new Date().toLocaleTimeString(), 4, ch-4);
  const cnt = state.canvasVehicles.filter(v=>!v.cleared).length;
  cctv.textAlign='right';
  cctv.fillStyle='rgba(180,200,220,0.45)';
  cctv.fillText(`TRK:${cnt}`, cw-4, 10);

  // Scan line
  scanY = (scanY+0.8)%ch;
  cctv.fillStyle='rgba(34,197,94,0.03)';
  cctv.fillRect(0,scanY,cw,2);

  // Vignette
  const vig = cctv.createRadialGradient(cw/2,ch/2,ch*0.2,cw/2,ch/2,ch*0.75);
  vig.addColorStop(0,'rgba(0,0,0,0)'); vig.addColorStop(1,'rgba(0,0,0,0.55)');
  cctv.fillStyle=vig; cctv.fillRect(0,0,cw,ch);
}

// ─── PHASE DIAGRAM ────────────────────────────────────────────────────────────
function renderPhaseDiagram() {
  const container = document.getElementById('phaseDiagram');
  if (!container) return;
  const c = state.cycleLength||90;
  container.innerHTML = PHASES.map(ph=>{
    const g   = (state.greenSplits||{})[ph]||15;
    const gPct= (g/c*100).toFixed(1);
    const yPct= (3/c*100).toFixed(1);
    const rPct= (100-parseFloat(gPct)-parseFloat(yPct)).toFixed(1);
    const isActive = ph===state.currentPhase && state.mode!=='ALL_RED';
    const cursorPct = Math.min((state.phaseTimer/c)*100,100).toFixed(1);
    return `<div class="pd-row">
      <span class="pd-label">${ph.substring(0,1)}</span>
      <div class="pd-track">
        <div class="pd-green"  style="left:0;width:${gPct}%"></div>
        <div class="pd-yellow" style="left:${gPct}%;width:${yPct}%"></div>
        <div class="pd-red"    style="left:${parseFloat(gPct)+parseFloat(yPct)}%;width:${rPct}%"></div>
        ${isActive ? `<div class="pd-current" style="left:${cursorPct}%"></div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ─── HUD UPDATE ───────────────────────────────────────────────────────────────
function updateHUD() {
  // Clock
  document.getElementById('clockDisplay').textContent = new Date().toLocaleTimeString();
  // Uptime
  const s = state.uptime;
  document.getElementById('uptimeDisplay').textContent =
    [Math.floor(s/3600),Math.floor((s%3600)/60),Math.floor(s%60)]
    .map(n=>String(n).padStart(2,'0')).join(':');
  document.getElementById('cycleCount').textContent   = state.telemetry.cycleCount;

  // Webster
  document.getElementById('cycleVal').textContent     = state.cycleLength;
  document.getElementById('activePhase').textContent  = state.currentPhase;
  document.getElementById('phaseTimer').textContent   = `${state.phaseTimer.toFixed(1)} s`;
  document.getElementById('controllerMode').textContent = state.mode;

  const Y = Object.values(state.flows).reduce((a,q)=>a+q/1800,0);
  document.getElementById('websterY').textContent = Math.min(Y,0.99).toFixed(3);

  // Cycle ring
  drawCycleRing(state.cycleLength, state.phaseTimer);

  // Stats
  document.getElementById('avgDelay').textContent     = state.telemetry.avgDelay.toFixed(1);
  document.getElementById('throughput').textContent   = Math.round(state.telemetry.throughput);
  document.getElementById('emergencyCount').textContent = state.telemetry.emergencyCount;
  document.getElementById('gapOutCount').textContent  = state.telemetry.gapOutCount;
  document.getElementById('vehiclesServed').textContent = state.telemetry.totalVehiclesServed;
  const spds = state.telemetry.vehicleSpeeds||[];
  document.getElementById('avgSpeed').textContent =
    spds.length ? (spds.reduce((a,b)=>a+b,0)/spds.length).toFixed(1) : '—';

  // Toolbar badges
  const vCount = state.canvasVehicles.filter(v=>!v.cleared).length;
  document.getElementById('tbVehicleCount').textContent = `${vCount} vehicles`;
  const tbPhase = document.getElementById('tbActivePhase');
  const sig = state.signals[state.currentPhase];
  tbPhase.textContent = `${state.currentPhase} ${sig}`;
  tbPhase.className = 'tb-badge' + (sig==='GREEN'?' tb-badge--green': sig==='YELLOW'?' tb-badge--yellow':' tb-badge--red');

  // Emergency banner
  const banner = document.getElementById('emergencyBanner');
  const badge  = document.getElementById('modeBadge');
  if (state.emergencyActive) {
    banner.classList.remove('hidden');
    document.getElementById('emergencyApproach').textContent = state.emergencyPhase;
    document.getElementById('evStepBadge').textContent = state.emergencyStep;
    badge.textContent = 'Emergency';
    badge.className = 'mode-tag mode-tag--emergency';
  } else {
    banner.classList.add('hidden');
    badge.textContent = 'Actuated';
    badge.className = 'mode-tag';
  }

  // Signal overlays
  updateSignalOverlays();

  // Queue
  for (const ph of PHASES) {
    const qEl = document.getElementById(`queue_${ph}`);
    if (qEl) qEl.textContent = (state.telemetry.queueLengths||{})[ph]||0;
  }

  // Flow sliders sync
  for (const ph of PHASES) {
    const sl = document.getElementById(`slider${ph}`);
    if (sl && Math.abs(parseInt(sl.value)-state.flows[ph])>100) {
      sl.value = state.flows[ph];
      document.getElementById(`flowVal${ph}`).textContent = state.flows[ph];
    }
    const sat = document.getElementById(`sat${ph}`);
    if (sat) sat.style.width = `${(state.flows[ph]/1800*100).toFixed(1)}%`;
  }

  // Charts
  flowChart.data.datasets[0].data = PHASES.map(p=>state.flows[p]);
  flowChart.update('none');
  delayData.push(Math.round(state.telemetry.avgDelay));
  delayData.shift();
  delayChart.data.datasets[0].data = [...delayData];
  delayChart.update('none');

  // Split bars
  renderSplitBars();
  // Phase diagram
  renderPhaseDiagram();
  // Vehicle table
  renderVehicleTable();
  // Audit log
  renderAuditLog();
}

function updateSignalOverlays() {
  for (const ph of PHASES) {
    const sig = state.signals[ph];
    const r = document.getElementById(`sigR_${ph}`);
    const y = document.getElementById(`sigY_${ph}`);
    const g = document.getElementById(`sigG_${ph}`);
    const t = document.getElementById(`sigText_${ph}`);
    if (!r) continue;
    r.className = 'sig-bulb' + (sig==='RED'    ?' lit-red':'');
    y.className = 'sig-bulb' + (sig==='YELLOW' ?' lit-yellow':'');
    g.className = 'sig-bulb' + (sig==='GREEN'  ?' lit-green':'');
    t.textContent = sig;
    t.style.color = sig==='GREEN'?'#22c55e': sig==='YELLOW'?'#f59e0b':'#ef4444';
  }
}

function renderSplitBars() {
  const el = document.getElementById('splitBarsGrid');
  if (!el) return;
  const C = state.cycleLength||90;
  const colMap = {NORTH:'#3b82f6',SOUTH:'#14b8a6',EAST:'#f59e0b',WEST:'#8b5cf6'};
  el.innerHTML = PHASES.map(ph=>{
    const g   = (state.greenSplits||{})[ph]||0;
    const pct = Math.min(100,(g/C*100));
    return `<div class="split-bar-row">
      <span class="split-bar-label">${ph.substring(0,1)}</span>
      <div class="split-bar-track">
        <div class="split-bar-fill" style="width:${pct.toFixed(1)}%;background:${colMap[ph]}"></div>
      </div>
      <span class="split-bar-val">${g.toFixed(1)}s</span>
    </div>`;
  }).join('');
}

function renderVehicleTable() {
  const tbody = document.getElementById('vehicleTbody');
  if (!tbody) return;
  const vs = (state.trackedVehicles||[]).slice(-10).reverse();
  tbody.innerHTML = vs.map(v=>{
    const cls = `type-${v.type.toLowerCase()}`;
    const spd = v.speedKph?v.speedKph.toFixed(1):'—';
    const st  = v.crossedLine2
      ? '<span style="color:#5a6682">Departed</span>'
      : '<span style="color:#22c55e">Tracking</span>';
    return `<tr>
      <td style="color:#5a6682;font-family:var(--mono)">#${v.id}</td>
      <td class="${cls}">${v.type}</td>
      <td>${v.approach}</td>
      <td style="font-family:var(--mono)">${spd}</td>
      <td>${st}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="color:#5a6682;text-align:center;padding:12px">No active tracks</td></tr>';
}

function renderAuditLog() {
  const el = document.getElementById('auditLog');
  if (!el) return;
  const records = state.walRecords.slice(-30).reverse();
  document.getElementById('walCount').textContent = `${state.walRecords.length} records`;
  el.innerHTML = records.map(r=>{
    const ts = new Date(r.timestamp).toLocaleTimeString();
    const isEm = r.event.includes('EMERGENCY');
    const isPh = r.event.includes('PHASE');
    const cls  = isEm?'al-ev--emergency': isPh?'al-ev--phase':'al-ev';
    return `<div class="al-row">
      <span class="al-ts">${ts}</span>
      <span class="${cls}">${r.event}</span>
      ${r.data?`<span class="al-data">${JSON.stringify(r.data).substring(0,36)}</span>`:''}
    </div>`;
  }).join('') || '<div class="al-row"><span class="al-ts">—</span><span style="color:#5a6682">No events yet</span></div>';
}

// ─── MAIN LOOPS ───────────────────────────────────────────────────────────────
function renderLoop() {
  updateVehicles();
  draw();
  drawCCTV();
  requestAnimationFrame(renderLoop);
}

async function init() {
  await fetchState();
  updateHUD();
  await fetchAnalytics();
  renderLoop();
  setInterval(async ()=>{ await fetchState(); updateHUD(); }, 600);
  setInterval(fetchAnalytics, 5000);
}

init();
