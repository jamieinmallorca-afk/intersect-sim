/**
 * ═══════════════════════════════════════════════════════════════
 *  INTERSECT SIM — sim.js
 *  Intersection traffic simulator powered by Claude AI vision
 *
 *  Architecture:
 *    ImageAnalyser   — sends screenshot to Claude, parses road structure
 *    RoadNetwork     — stores detected roads, lanes, intersections
 *    Vehicle         — individual car state machine
 *    TrafficSignal   — traffic light controller
 *    Simulation      — master loop, spawning, physics
 *    Renderer        — draws everything onto canvas
 *    MetricsTracker  — rolling stats, sparkline
 *    AppController   — wires UI to simulation
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

// ── CONSTANTS ───────────────────────────────────────────────────
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-sonnet-4-20250514';

const CAR_W   = 10;   // px
const CAR_H   = 6;    // px
const FPS     = 30;

const VOLUME_RATES = {
  low:     6  / 60,   // cars per second total
  medium:  20 / 60,
  high:    45 / 60,
  extreme: 90 / 60,
};

const TIME_PERIODS = [
  { h: [0,5],   label: 'NIGHT',         mult: 0.1  },
  { h: [5,7],   label: 'EARLY MORNING', mult: 0.3  },
  { h: [7,9],   label: 'MORNING RUSH',  mult: 1.4  },
  { h: [9,12],  label: 'MID MORNING',   mult: 0.7  },
  { h: [12,14], label: 'LUNCH RUSH',    mult: 1.0  },
  { h: [14,16], label: 'AFTERNOON',     mult: 0.65 },
  { h: [16,19], label: 'EVENING RUSH',  mult: 1.5  },
  { h: [19,21], label: 'EVENING',       mult: 0.5  },
  { h: [21,24], label: 'NIGHT',         mult: 0.2  },
];

// Rule system behavioural parameters
const RULE_SYSTEMS = {
  uk:      { laneChangePr: 0.003, hesitationMean: 0.4, conflictFactor: 0.25 },
  us:      { laneChangePr: 0.008, hesitationMean: 0.5, conflictFactor: 0.30 },
  spanish: { laneChangePr: 0.025, hesitationMean: 0.9, conflictFactor: 0.55 },
};

// ════════════════════════════════════════════════════════════════
//  IMAGE ANALYSER — calls Claude vision API
// ════════════════════════════════════════════════════════════════

class ImageAnalyser {
  /**
   * Sends the uploaded map image to Claude with a structured prompt
   * asking it to identify roads, lanes, intersection type, signals etc.
   * Returns a RoadNetwork object built from the JSON response.
   */
  static async analyse(imageBase64, mimeType, canvasW, canvasH, apiKey) {

    const systemPrompt = `You are a traffic engineering AI. 
Analyse the provided map/satellite image of a road intersection.
Respond ONLY with a single valid JSON object — no markdown, no explanation.

The JSON must follow this schema exactly:
{
  "intersectionType": "4-way" | "T-junction" | "roundabout" | "complex" | "unknown",
  "numRoads": <integer 2-6>,
  "roads": [
    {
      "id": <integer>,
      "angleDeg": <0-360, where 0=right, 90=up>,
      "lanesIn": <1-4>,
      "lanesOut": <1-4>,
      "hasTrafficLight": <boolean>,
      "hasCrosswalk": <boolean>,
      "roadType": "major" | "minor" | "highway"
    }
  ],
  "hasCentralIsland": <boolean>,
  "estimatedSpeedLimit": <integer kmh>,
  "features": [<short string description of notable features, up to 6 items>],
  "confidence": <0.0-1.0>
}`;

    const userContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: imageBase64 }
      },
      {
        type: 'text',
        text: 'Analyse this map image and return the JSON road network description.'
      }
    ];

    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!response.ok) {
      throw new Error(`API error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const raw  = data.content.map(b => b.text || '').join('');

    let parsed;
    try {
      // Strip any accidental markdown fences
      const clean = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      throw new Error('Could not parse AI response as JSON: ' + raw.slice(0, 200));
    }

    return ImageAnalyser._buildNetwork(parsed, canvasW, canvasH);
  }

  static _buildNetwork(data, W, H) {
    const cx = W / 2;
    const cy = H / 2;
    const reach = Math.min(W, H) * 0.42;

    const roads = (data.roads || []).map(r => {
      const angleRad = (r.angleDeg || 0) * Math.PI / 180;
      return {
        id:          r.id,
        angleDeg:    r.angleDeg || 0,
        angleRad,
        lanesIn:     Math.max(1, Math.min(4, r.lanesIn  || 1)),
        lanesOut:    Math.max(1, Math.min(4, r.lanesOut || 1)),
        hasSignal:   r.hasTrafficLight || false,
        hasCrosswalk:r.hasCrosswalk    || false,
        roadType:    r.roadType || 'minor',
        // Computed endpoints
        ex: cx + Math.cos(angleRad) * reach,
        ey: cy - Math.sin(angleRad) * reach,
        // Entry/exit points closer to intersection
        ix: cx + Math.cos(angleRad) * 50,
        iy: cy - Math.sin(angleRad) * 50,
      };
    });

    // Fallback: if AI returned nothing useful, synthesise a 4-way
    if (roads.length < 2) {
      return ImageAnalyser._fallback4Way(W, H, data);
    }

    return {
      intersectionType: data.intersectionType || '4-way',
      roads,
      cx, cy, reach,
      hasCentralIsland: data.hasCentralIsland || false,
      speedLimit:       data.estimatedSpeedLimit || 50,
      features:         data.features || [],
      confidence:       data.confidence || 0.7,
      rawData:          data,
    };
  }

  static _fallback4Way(W, H, data) {
    const cx = W / 2, cy = H / 2;
    const reach = Math.min(W, H) * 0.42;
    const angles = [0, 90, 180, 270];
    const roads = angles.map((deg, i) => {
      const rad = deg * Math.PI / 180;
      return {
        id: i, angleDeg: deg, angleRad: rad,
        lanesIn: 2, lanesOut: 2,
        hasSignal: true, hasCrosswalk: true, roadType: 'major',
        ex: cx + Math.cos(rad) * reach,
        ey: cy - Math.sin(rad) * reach,
        ix: cx + Math.cos(rad) * 50,
        iy: cy - Math.sin(rad) * 50,
      };
    });
    return {
      intersectionType: '4-way', roads, cx, cy, reach,
      hasCentralIsland: false, speedLimit: 50,
      features: data.features || ['Standard 4-way intersection'],
      confidence: 0.5, rawData: data,
    };
  }
}

// ════════════════════════════════════════════════════════════════
//  TRAFFIC SIGNAL
// ════════════════════════════════════════════════════════════════

class TrafficSignal {
  constructor(roads, timing) {
    this.roads      = roads;
    this.timing     = timing;   // 'adaptive' | 'fixed30' | 'fixed60' | 'none'
    this.phases     = this._buildPhases();
    this.phaseIdx   = 0;
    this.phaseTimer = 0;
    this.states     = {};       // roadId → 'green'|'yellow'|'red'
    this._applyPhase();
  }

  _buildPhases() {
    // Simple alternating phase pairs (opposite roads get green together)
    const roadIds = this.roads.map(r => r.id);
    if (roadIds.length <= 2) return [roadIds];
    // Pair opposite roads
    const phases = [];
    const used = new Set();
    for (let i = 0; i < this.roads.length; i++) {
      if (used.has(i)) continue;
      // Find road roughly opposite (180°)
      let oppIdx = -1;
      for (let j = i + 1; j < this.roads.length; j++) {
        if (used.has(j)) continue;
        const diff = Math.abs(this.roads[i].angleDeg - this.roads[j].angleDeg);
        if (Math.abs(diff - 180) < 45) { oppIdx = j; break; }
      }
      const phase = [this.roads[i].id];
      if (oppIdx >= 0) { phase.push(this.roads[oppIdx].id); used.add(oppIdx); }
      used.add(i);
      phases.push(phase);
    }
    return phases.length ? phases : [roadIds];
  }

  _phaseDuration() {
    if (this.timing === 'fixed30') return 30;
    if (this.timing === 'fixed60') return 60;
    if (this.timing === 'none')    return Infinity;
    // Adaptive: proportional to road width (lanesIn)
    const greenRoads = this.phases[this.phaseIdx];
    const totalLanes = greenRoads.reduce((s, id) => {
      const r = this.roads.find(r => r.id === id);
      return s + (r ? r.lanesIn : 1);
    }, 0);
    return 20 + totalLanes * 5;
  }

  _applyPhase() {
    if (this.timing === 'none') {
      this.roads.forEach(r => { this.states[r.id] = 'green'; });
      return;
    }
    const greenSet = new Set(this.phases[this.phaseIdx]);
    this.roads.forEach(r => {
      this.states[r.id] = greenSet.has(r.id) ? 'green' : 'red';
    });
  }

  isGreen(roadId) {
    return this.timing === 'none' || this.states[roadId] === 'green';
  }

  step(dt) {
    if (this.timing === 'none') return;
    this.phaseTimer += dt;
    const dur = this._phaseDuration();
    if (this.phaseTimer >= dur) {
      this.phaseTimer = 0;
      this.phaseIdx   = (this.phaseIdx + 1) % this.phases.length;
      this._applyPhase();
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  VEHICLE
// ════════════════════════════════════════════════════════════════

class Vehicle {
  constructor(id, network, entryRoadIdx, rules, signal) {
    this.id          = id;
    this.network     = network;
    this.rules       = rules;
    this.signal      = signal;

    const cx = network.cx, cy = network.cy;
    const roads = network.roads;

    this.entryRoad = roads[entryRoadIdx];
    // Pick a random exit road (not the same as entry)
    const exits = roads.filter((_, i) => i !== entryRoadIdx);
    this.exitRoad  = exits[Math.floor(Math.random() * exits.length)] || this.entryRoad;

    // Start far end of entry road
    this.x         = this.entryRoad.ex;
    this.y         = this.entryRoad.ey;

    // State machine: APPROACHING → WAITING → CROSSING → EXITING → DONE
    this.state     = 'APPROACHING';
    this.speed     = 2.2 + Math.random() * 0.8;   // px/frame normal speed
    this.baseSpeed = this.speed;
    this.hesTimer  = 0;
    this.waitTime  = 0;
    this.totalTime = 0;
    this.conflictDelay = 0;

    // Colour
    this.colour    = '#4ade80';

    // Path: series of waypoints
    this.path      = this._buildPath();
    this.pathIdx   = 0;
  }

  _buildPath() {
    const net = this.network;
    const cx  = net.cx, cy = net.cy;
    const er  = this.entryRoad;
    const xr  = this.exitRoad;

    // Slight perpendicular lane offset
    const laneOff = (Math.random() - 0.5) * 12;
    const perpIn  = er.angleRad + Math.PI / 2;
    const perpOut = xr.angleRad + Math.PI / 2;

    const stopX   = er.ix + Math.cos(perpIn)  * laneOff;
    const stopY   = er.iy - Math.sin(perpIn)  * laneOff;
    const exitX   = xr.ix + Math.cos(perpOut) * laneOff;
    const exitY   = xr.iy - Math.sin(perpOut) * laneOff;
    const farX    = xr.ex + Math.cos(perpOut) * laneOff;
    const farY    = xr.ey - Math.sin(perpOut) * laneOff;

    return [
      { x: stopX, y: stopY, action: 'STOP_CHECK' },
      { x: cx + (Math.random() - 0.5) * 20,
        y: cy + (Math.random() - 0.5) * 20, action: 'CROSS' },
      { x: exitX, y: exitY, action: 'EXIT' },
      { x: farX,  y: farY,  action: 'DONE' },
    ];
  }

  step(dt, allVehicles) {
    this.totalTime += dt;
    const target = this.path[this.pathIdx];
    if (!target) { this.state = 'DONE'; return; }

    const dx   = target.x - this.x;
    const dy   = target.y - this.y;
    const dist = Math.hypot(dx, dy);

    // ── State logic ────────────────────────────────────────
    if (target.action === 'STOP_CHECK' && dist < 8) {
      // At entry — check signal and gap
      this.state = 'WAITING';
      this.waitTime += dt;

      const canGo = this.signal.isGreen(this.entryRoad.id) &&
                    this._clearToEnter(allVehicles);

      // Hesitation from rule system
      if (canGo) {
        this.hesTimer -= dt;
        if (this.hesTimer <= 0) {
          this.pathIdx++;
          this.state = 'CROSSING';
          this.hesTimer = this._drawHesitation();
        }
      } else {
        this.hesTimer = this._drawHesitation();
      }
      this._updateColour();
      return;
    }

    if (dist < 4) {
      if (target.action === 'DONE') { this.state = 'DONE'; return; }
      this.pathIdx++;
      this._updateColour();
      return;
    }

    // ── Collision avoidance ────────────────────────────────
    let effectiveSpeed = this.baseSpeed;
    const nearest = this._nearestAhead(allVehicles, dx / dist, dy / dist);
    if (nearest < 18) {
      effectiveSpeed *= Math.max(0.05, (nearest - 8) / 10);
      this.state = nearest < 10 ? 'STOPPED' : 'SLOWING';
    } else {
      this.state = this.state === 'WAITING' ? 'WAITING' : 'APPROACHING';
    }

    effectiveSpeed *= (dt * FPS);
    this.x += (dx / dist) * effectiveSpeed;
    this.y += (dy / dist) * effectiveSpeed;

    this._updateColour();
  }

  _clearToEnter(allVehicles) {
    // Check no vehicle is too close to the intersection centre
    const cx = this.network.cx, cy = this.network.cy;
    for (const v of allVehicles) {
      if (v === this || v.state === 'DONE') continue;
      if (v.state === 'CROSSING') {
        const dist = Math.hypot(v.x - cx, v.y - cy);
        if (dist < 40) return false;
      }
    }
    return true;
  }

  _nearestAhead(allVehicles, dx, dy) {
    let minD = Infinity;
    for (const v of allVehicles) {
      if (v === this || v.state === 'DONE') continue;
      const vdx = v.x - this.x;
      const vdy = v.y - this.y;
      const dot = vdx * dx + vdy * dy;
      if (dot < 0) continue;   // behind us
      const d = Math.hypot(vdx, vdy);
      if (d < minD) minD = d;
    }
    return minD;
  }

  _drawHesitation() {
    const { hesitationMean } = this.rules;
    return Math.max(0, hesitationMean + (Math.random() - 0.5) * hesitationMean);
  }

  _updateColour() {
    if (this.state === 'STOPPED' || this.state === 'WAITING') {
      this.colour = '#f87171';
    } else if (this.state === 'SLOWING') {
      this.colour = '#facc15';
    } else {
      this.colour = '#4ade80';
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  METRICS TRACKER
// ════════════════════════════════════════════════════════════════

class MetricsTracker {
  constructor() {
    this.completed      = 0;
    this.totalWait      = 0;
    this.history        = { queue: [], throughput: [], wait: [] };
    this.maxHistory     = 120;
    this._recentDone    = [];   // timestamps of completed trips
    this._tickCount     = 0;
  }

  record(vehicles, simTime) {
    this._tickCount++;
    if (this._tickCount % FPS !== 0) return;   // once per second

    const queue  = vehicles.filter(v => v.state === 'WAITING' || v.state === 'STOPPED').length;
    const avg    = this.completed > 0 ? this.totalWait / this.completed : 0;

    // Throughput: completions in last 60s
    const cutoff = simTime - 60;
    this._recentDone = this._recentDone.filter(t => t >= cutoff);
    const tput   = this._recentDone.length;

    this._push('queue', queue);
    this._push('throughput', tput);
    this._push('wait', avg);
  }

  onComplete(vehicle) {
    this.completed++;
    this.totalWait += vehicle.waitTime;
    this._recentDone.push(vehicle.totalTime);   // approximate
  }

  _push(key, val) {
    this.history[key].push(val);
    if (this.history[key].length > this.maxHistory) {
      this.history[key].shift();
    }
  }

  snapshot(vehicles) {
    const queue = vehicles.filter(v => v.state === 'WAITING' || v.state === 'STOPPED').length;
    const avg   = this.completed > 0 ? this.totalWait / this.completed : 0;
    const tput  = this._recentDone.length;
    const circ  = vehicles.filter(v => v.state === 'CROSSING');
    let risk = 0;
    for (let i = 0; i < circ.length; i++) {
      for (let j = i + 1; j < circ.length; j++) {
        if (Math.hypot(circ[i].x - circ[j].x, circ[i].y - circ[j].y) < 20) risk++;
      }
    }
    return {
      throughput: tput,
      avgWait:    avg,
      queue,
      risk:       Math.min(1, risk * 0.15),
      total:      vehicles.length,
    };
  }

  exportCSV(history) {
    const rows = ['tick,queue,throughput,avg_wait'];
    const len  = Math.max(history.queue.length, history.throughput.length, history.wait.length);
    for (let i = 0; i < len; i++) {
      rows.push([
        i,
        history.queue[i]      ?? '',
        history.throughput[i] ?? '',
        (history.wait[i]      ?? '').toFixed ? (history.wait[i]).toFixed(2) : '',
      ].join(','));
    }
    return rows.join('\n');
  }
}

// ════════════════════════════════════════════════════════════════
//  RENDERER
// ════════════════════════════════════════════════════════════════

class Renderer {
  constructor(canvas, network) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.network = network;
    this.W       = canvas.width;
    this.H       = canvas.height;
  }

  clear() {
    const ctx = this.ctx;
    ctx.fillStyle = '#0a0c0f';
    ctx.fillRect(0, 0, this.W, this.H);
    // Grid
    ctx.strokeStyle = 'rgba(42,47,58,0.5)';
    ctx.lineWidth = 1;
    for (let x = 0; x < this.W; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.H); ctx.stroke();
    }
    for (let y = 0; y < this.H; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.W, y); ctx.stroke();
    }
  }

  drawRoads(signal) {
    const ctx = this.ctx;
    const net  = this.network;

    net.roads.forEach(road => {
      const laneW = 12;
      const totalW = (road.lanesIn + road.lanesOut) * laneW + 8;
      const perp  = road.angleRad + Math.PI / 2;

      // Road surface
      ctx.save();
      ctx.translate(net.cx, net.cy);
      ctx.rotate(-road.angleRad);
      ctx.fillStyle = road.roadType === 'highway' ? '#2d3142' : '#1e2128';
      ctx.fillRect(0, -totalW / 2, Math.hypot(road.ex - net.cx, road.ey - net.cy), totalW);
      // Lane markings
      ctx.strokeStyle = 'rgba(240,224,96,0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([12, 10]);
      const reach = Math.hypot(road.ex - net.cx, road.ey - net.cy);
      for (let l = 1; l < road.lanesIn + road.lanesOut; l++) {
        const off = -totalW / 2 + l * laneW + 4;
        ctx.beginPath(); ctx.moveTo(40, off); ctx.lineTo(reach, off); ctx.stroke();
      }
      ctx.setLineDash([]);
      // Centre line
      ctx.strokeStyle = 'rgba(240,224,96,0.7)';
      ctx.lineWidth   = 1.5;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(reach, 0); ctx.stroke();
      ctx.restore();

      // Traffic signal indicator
      if (road.hasSignal && signal) {
        const sigX = road.ix + Math.cos(road.angleRad) * 20 + Math.cos(perp) * 18;
        const sigY = road.iy - Math.sin(road.angleRad) * 20 - Math.sin(perp) * 18;
        const col  = signal.states[road.id] === 'green'
          ? '#22c55e' : signal.states[road.id] === 'yellow' ? '#facc15' : '#ef4444';
        ctx.beginPath();
        ctx.arc(sigX, sigY, 5, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth   = 1;
        ctx.stroke();
        // Glow
        ctx.beginPath();
        ctx.arc(sigX, sigY, 9, 0, Math.PI * 2);
        ctx.fillStyle = col + '33';
        ctx.fill();
      }
    });

    // Intersection box
    const isRound = net.intersectionType === 'roundabout';
    ctx.save();
    if (isRound) {
      const r = 55;
      ctx.beginPath();
      ctx.arc(net.cx, net.cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1e2128';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(net.cx, net.cy, 22, 0, Math.PI * 2);
      ctx.fillStyle = '#2a4a2e';
      ctx.fill();
      ctx.strokeStyle = '#3d4452';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      const hw = net.roads.reduce((m, r) => Math.max(m, (r.lanesIn + r.lanesOut) * 12 + 8), 40);
      ctx.fillStyle = '#1e2128';
      ctx.fillRect(net.cx - hw, net.cy - hw, hw * 2, hw * 2);
    }
    ctx.restore();
  }

  drawVehicles(vehicles) {
    const ctx = this.ctx;
    vehicles.forEach(v => {
      if (v.state === 'DONE') return;
      const angle = v.pathIdx < v.path.length
        ? Math.atan2(v.path[v.pathIdx].y - v.y, v.path[v.pathIdx].x - v.x)
        : 0;

      ctx.save();
      ctx.translate(v.x, v.y);
      ctx.rotate(angle);

      // Shadow
      ctx.shadowColor  = v.colour + '66';
      ctx.shadowBlur   = 6;

      // Car body
      ctx.fillStyle    = v.colour;
      ctx.strokeStyle  = '#00000066';
      ctx.lineWidth    = 1;
      ctx.beginPath();
      ctx.roundRect(-CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H, 2);
      ctx.fill();
      ctx.stroke();

      // Windscreen
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(1, -CAR_H / 2 + 1, CAR_W / 2 - 2, CAR_H - 2);

      ctx.shadowBlur = 0;
      ctx.restore();
    });
  }

  drawSpeedHeatmap(vehicles) {
    // Draw a subtle radial heatmap around congested areas
    const ctx = this.ctx;
    const stopped = vehicles.filter(v => v.state === 'STOPPED' || v.state === 'WAITING');
    stopped.forEach(v => {
      const grad = ctx.createRadialGradient(v.x, v.y, 0, v.x, v.y, 35);
      grad.addColorStop(0,   'rgba(239,68,68,0.15)');
      grad.addColorStop(1,   'rgba(239,68,68,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(v.x, v.y, 35, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

// ════════════════════════════════════════════════════════════════
//  SIMULATION
// ════════════════════════════════════════════════════════════════

class Simulation {
  constructor(network, opts) {
    this.network   = network;
    this.opts      = opts;   // { volume, timeHour, signalTiming, ruleSystem, speed }
    this.vehicles  = [];
    this.signal    = new TrafficSignal(network.roads, opts.signalTiming);
    this.metrics   = new MetricsTracker();
    this.simTime   = 0;
    this._nextId   = 0;
    this._spawnAcc = 0;
    this.running   = false;
  }

  _spawnRate() {
    const base   = VOLUME_RATES[this.opts.volume] || VOLUME_RATES.medium;
    const period = TIME_PERIODS.find(p => {
      const h = this.opts.timeHour;
      return h >= p.h[0] && h < p.h[1];
    }) || TIME_PERIODS[0];
    return base * period.mult * this.opts.speed;
  }

  step(dtSec) {
    const dt = dtSec * this.opts.speed;
    this.simTime += dt;

    // Signal step
    this.signal.step(dt);

    // Spawn
    this._spawnAcc += dt;
    const interval = 1 / this._spawnRate();
    while (this._spawnAcc >= interval) {
      this._spawnAcc -= interval;
      this._spawnVehicle();
    }

    // Update vehicles
    for (const v of this.vehicles) {
      v.step(dt, this.vehicles);
    }

    // Remove done vehicles
    const done = this.vehicles.filter(v => v.state === 'DONE');
    done.forEach(v => this.metrics.onComplete(v));
    this.vehicles = this.vehicles.filter(v => v.state !== 'DONE');

    // Record metrics
    this.metrics.record(this.vehicles, this.simTime);
  }

  _spawnVehicle() {
    if (this.network.roads.length === 0) return;
    // Cap active vehicles to avoid runaway congestion
    if (this.vehicles.length > 120) return;

    const roadIdx = Math.floor(Math.random() * this.network.roads.length);
    const rules   = RULE_SYSTEMS[this.opts.ruleSystem] || RULE_SYSTEMS.uk;
    const v       = new Vehicle(
      this._nextId++, this.network, roadIdx, rules, this.signal
    );
    this.vehicles.push(v);
  }

  updateOpts(opts) {
    this.opts = { ...this.opts, ...opts };
    if (opts.signalTiming) {
      this.signal = new TrafficSignal(this.network.roads, opts.signalTiming);
    }
  }

  getSnapshot() {
    return this.metrics.snapshot(this.vehicles);
  }
}

// ════════════════════════════════════════════════════════════════
//  GRAPH RENDERER
// ════════════════════════════════════════════════════════════════

class GraphRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
  }

  draw(history, metric) {
    const ctx = this.ctx;
    const W   = this.canvas.width;
    const H   = this.canvas.height;
    const data = history[metric] || [];

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#1c2028';
    ctx.fillRect(0, 0, W, H);

    if (data.length < 2) return;

    const maxVal = Math.max(...data, 1);
    const pad    = 10;
    const gW     = W - pad * 2;
    const gH     = H - pad * 2;

    // Area fill
    ctx.beginPath();
    ctx.moveTo(pad, H - pad);
    data.forEach((v, i) => {
      const x = pad + (i / (data.length - 1)) * gW;
      const y = H - pad - (v / maxVal) * gH;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(W - pad, H - pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(245,158,11,0.4)');
    grad.addColorStop(1, 'rgba(245,158,11,0.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad + (i / (data.length - 1)) * gW;
      const y = H - pad - (v / maxVal) * gH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Latest value dot
    const last = data[data.length - 1];
    const lx   = W - pad;
    const ly   = H - pad - (last / maxVal) * gH;
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
  }
}

// ════════════════════════════════════════════════════════════════
//  APP CONTROLLER
// ════════════════════════════════════════════════════════════════

class AppController {
  constructor() {
    this.network    = null;
    this.simulation = null;
    this.renderer   = null;
    this.graphRdr   = null;
    this.animId     = null;
    this.simTime    = 0;

    this.opts = {
      volume:       'medium',
      timeHour:     8,
      signalTiming: 'adaptive',
      ruleSystem:   'uk',
      speed:        1,
    };

    this._bindUI();
  }

  _bindUI() {
    // Upload zone
    const zone  = document.getElementById('uploadZone');
    const input = document.getElementById('fileInput');

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) this._handleFile(file);
    });
    input.addEventListener('change', () => {
      if (input.files[0]) this._handleFile(input.files[0]);
    });

    document.getElementById('btnReupload').addEventListener('click', () => {
      document.getElementById('previewSection').style.display = 'none';
      document.getElementById('uploadZone').style.display = '';
      document.getElementById('controlsSection').style.display = 'none';
      document.getElementById('analysisSection').style.display = 'none';
      document.getElementById('btnExport').style.display = 'none';
      this._stopSim();
    });

    // Pill button groups
    this._bindPills('volumeBtns', 'volume');
    this._bindPills('signalBtns', 'signalTiming');
    this._bindPills('ruleBtns',   'ruleSystem');

    // Time slider
    const timeSl = document.getElementById('timeSlider');
    timeSl.addEventListener('input', () => {
      const h = parseInt(timeSl.value);
      this.opts.timeHour = h;
      document.getElementById('timeLabel').textContent =
        String(h).padStart(2, '0') + ':00';
      const period = TIME_PERIODS.find(p => h >= p.h[0] && h < p.h[1]);
      document.getElementById('timePeriod').textContent = period ? period.label : '';
      if (this.simulation) this.simulation.updateOpts(this.opts);
    });

    // Speed slider
    const speedSl = document.getElementById('speedSlider');
    speedSl.addEventListener('input', () => {
      this.opts.speed = parseFloat(speedSl.value);
      document.getElementById('speedLabel').textContent = this.opts.speed + '×';
      if (this.simulation) this.simulation.updateOpts(this.opts);
    });

    // Run / Pause
    document.getElementById('btnRun').addEventListener('click', () => this._startSim());
    document.getElementById('btnPause').addEventListener('click', () => this._togglePause());

    // Export
    document.getElementById('btnExport').addEventListener('click', () => this._exportCSV());

    // Graph metric selector
    document.getElementById('graphMetric').addEventListener('change', () => {
      this._redrawGraph();
    });
  }

  _bindPills(groupId, optKey) {
    const group = document.getElementById(groupId);
    group.querySelectorAll('.pill').forEach(btn => {
      btn.addEventListener('click', () => {
        group.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.opts[optKey] = btn.dataset.value;
        if (this.simulation) this.simulation.updateOpts({ [optKey]: this.opts[optKey] });
      });
    });
  }

  async _handleFile(file) {
    // Show preview
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      const base64  = dataUrl.split(',')[1];
      const mime    = file.type;

      // Show thumbnail
      document.getElementById('mapThumb').src = dataUrl;
      document.getElementById('uploadZone').style.display = 'none';
      document.getElementById('previewSection').style.display = '';
      document.getElementById('hint-text');

      // Show loading overlay
      this._showOverlay('Detecting road structure', 0);
      await this._fakeProgress();

      try {
        // Size canvas
        const stage = document.getElementById('simStage');
        const W     = stage.clientWidth  || 800;
        const H     = stage.clientHeight || 600;

        this._updateOverlay('Analysing lane structure', 55);
        const apiKey = document.getElementById('apiKeyInput').value.trim();
        this.network = await ImageAnalyser.analyse(base64, mime, W, H, apiKey);
        this._updateOverlay('Building simulation model', 80);

        await new Promise(r => setTimeout(r, 400));
        this._updateOverlay('Ready!', 100);
        await new Promise(r => setTimeout(r, 500));

        this._hideOverlay();
        this._setupCanvas(W, H);
        this._showControls();
        this._showFeatures();

      } catch (err) {
        this._hideOverlay();
        console.error('Analysis failed:', err);
        // Fallback with a generic 4-way intersection
        const stage = document.getElementById('simStage');
        const W     = stage.clientWidth  || 800;
        const H     = stage.clientHeight || 600;
        this.network = ImageAnalyser._fallback4Way(W, H, { features: ['Fallback 4-way intersection (AI analysis failed — check API key)'] });
        this._setupCanvas(W, H);
        this._showControls();
        this._showFeatures();
        document.getElementById('hint-text') &&
          (document.querySelector('.hint-text').textContent = '⚠ Used fallback model — add API key for AI analysis');
      }
    };
    reader.readAsDataURL(file);
  }

  async _fakeProgress() {
    const steps = [
      ['Loading image…', 10],
      ['Detecting road edges…', 25],
      ['Identifying lanes…', 40],
    ];
    for (const [msg, pct] of steps) {
      this._updateOverlay(msg, pct);
      await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
    }
  }

  _showOverlay(msg, pct) {
    document.getElementById('analysisOverlay').style.display = 'flex';
    this._updateOverlay(msg, pct);
  }
  _updateOverlay(msg, pct) {
    document.getElementById('overlayStatus').textContent   = msg;
    document.getElementById('progressFill').style.width   = pct + '%';
  }
  _hideOverlay() {
    document.getElementById('analysisOverlay').style.display = 'none';
  }

  _setupCanvas(W, H) {
    const canvas = document.getElementById('simCanvas');
    canvas.width  = W;
    canvas.height = H;
    canvas.style.display = '';
    document.getElementById('stagePlaceholder').style.display = 'none';
    this.renderer = new Renderer(canvas, this.network);

    const gCanvas = document.getElementById('graphCanvas');
    this.graphRdr = new GraphRenderer(gCanvas);

    // Draw static roads immediately
    this.renderer.clear();
    this.renderer.drawRoads(null);
  }

  _showControls() {
    document.getElementById('controlsSection').style.display = '';
    document.getElementById('previewSection').style.display  = '';
    document.querySelector('.hint-text').textContent         = '';
    document.getElementById('btnExport').style.display       = '';
  }

  _showFeatures() {
    if (!this.network) return;
    const sec  = document.getElementById('analysisSection');
    const list = document.getElementById('featureList');
    list.innerHTML = '';

    const icons = { road: '🛣', lane: '🚗', signal: '🚦', crosswalk: '🚶', type: '⬡', speed: '⚡' };

    const features = [
      `Type: ${this.network.intersectionType}`,
      `Roads: ${this.network.roads.length}`,
      `Signals: ${this.network.roads.filter(r => r.hasSignal).length} arms`,
      `Speed limit: ~${this.network.speedLimit} km/h`,
      ...this.network.features.slice(0, 3),
    ];
    features.forEach((f, i) => {
      const li = document.createElement('li');
      li.dataset.icon = ['⬡','🛣','🚦','⚡','●','●','●'][i] || '●';
      li.textContent  = f;
      list.appendChild(li);
    });
    sec.style.display = '';
  }

  _startSim() {
    if (!this.network) return;
    this._stopSim();

    this.simulation = new Simulation(this.network, { ...this.opts });
    this.simTime    = 0;

    document.getElementById('btnRun').style.display   = 'none';
    document.getElementById('btnPause').style.display = '';
    document.getElementById('hud').style.display      = 'flex';

    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      this.simulation.step(dt);
      this.simTime += dt;

      this.renderer.clear();
      this.renderer.drawRoads(this.simulation.signal);
      this.renderer.drawSpeedHeatmap(this.simulation.vehicles);
      this.renderer.drawVehicles(this.simulation.vehicles);

      this._updateMetrics();
      this._redrawGraph();

      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  _stopSim() {
    if (this.animId) cancelAnimationFrame(this.animId);
    this.animId = null;
  }

  _togglePause() {
    if (this.animId) {
      this._stopSim();
      document.getElementById('btnPause').textContent = '▶  Resume';
    } else {
      this._startSim();
      document.getElementById('btnPause').textContent = '⏸  Pause';
    }
  }

  _updateMetrics() {
    if (!this.simulation) return;
    const s = this.simulation.getSnapshot();

    this._setMetric('metThroughput', s.throughput,       'barThroughput', s.throughput / 100);
    this._setMetric('metWait',       s.avgWait.toFixed(1),'barWait',       Math.min(1, s.avgWait / 60));
    this._setMetric('metQueue',      s.queue,            'barQueue',      Math.min(1, s.queue / 30));
    this._setMetric('metRisk',       (s.risk * 100).toFixed(0) + '%', 'barRisk', s.risk);

    // HUD
    document.getElementById('hudFlow').textContent = this.simulation.vehicles.filter(v => v.state === 'APPROACHING' || v.state === 'CROSSING').length;
    document.getElementById('hudSlow').textContent = this.simulation.vehicles.filter(v => v.state === 'SLOWING').length;
    document.getElementById('hudStop').textContent = this.simulation.vehicles.filter(v => v.state === 'STOPPED' || v.state === 'WAITING').length;

    const secs = Math.floor(this.simTime);
    document.getElementById('hudSimTime').textContent =
      String(Math.floor(secs / 60)).padStart(2, '0') + ':' +
      String(secs % 60).padStart(2, '0');
  }

  _setMetric(valueId, value, barId, fraction) {
    document.getElementById(valueId).textContent     = value;
    document.getElementById(barId).style.width       = Math.min(100, fraction * 100) + '%';
  }

  _redrawGraph() {
    if (!this.simulation || !this.graphRdr) return;
    const metric = document.getElementById('graphMetric').value;
    this.graphRdr.draw(this.simulation.metrics.history, metric);
  }

  _exportCSV() {
    if (!this.simulation) return;
    const csv  = this.simulation.metrics.exportCSV(this.simulation.metrics.history);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'intersection_metrics.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}

// ── BOOT ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  new AppController();
});
