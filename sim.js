/**
 * ═══════════════════════════════════════════════════════════════
 *  INTERSECT SIM — sim.js  (v2 — Motorway Junction Edition)
 *
 *  Supports two simulation modes detected automatically by AI:
 *    MODE "intersection" — traffic-light junctions, roundabouts
 *    MODE "motorway"     — highway interchanges, slip roads,
 *                          merge/diverge, acceleration lanes
 *
 *  Architecture:
 *    ImageAnalyser     — Claude vision → structured road JSON
 *    RoadNetwork       — normalised road graph for either mode
 *    Vehicle           — state machine with mode-aware behaviour
 *    TrafficSignal     — phased signal controller (intersection only)
 *    Simulation        — master tick loop
 *    Renderer          — canvas drawing for both modes
 *    MetricsTracker    — rolling stats + sparkline data
 *    AppController     — UI bindings
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const MODEL          = 'claude-sonnet-4-20250514';
const FPS            = 30;
const LANE_W         = 14;
const CAR_W          = 11;
const CAR_H          = 6;

const VOLUME_RATES = { low:5/60, medium:18/60, high:40/60, extreme:80/60 };

const TIME_PERIODS = [
  { h:[0,5],   label:'NIGHT',          mult:0.10 },
  { h:[5,7],   label:'EARLY MORNING',  mult:0.30 },
  { h:[7,9],   label:'MORNING RUSH',   mult:1.45 },
  { h:[9,12],  label:'MID MORNING',    mult:0.70 },
  { h:[12,14], label:'LUNCH RUSH',     mult:1.05 },
  { h:[14,16], label:'AFTERNOON',      mult:0.65 },
  { h:[16,19], label:'EVENING RUSH',   mult:1.55 },
  { h:[19,21], label:'EVENING',        mult:0.50 },
  { h:[21,24], label:'NIGHT',          mult:0.20 },
];

const RULE_SYSTEMS = {
  uk:      { laneChangePr:0.003, hesitationMean:0.40, conflictFactor:0.25 },
  us:      { laneChangePr:0.008, hesitationMean:0.50, conflictFactor:0.30 },
  spanish: { laneChangePr:0.025, hesitationMean:0.90, conflictFactor:0.55 },
};

const SPEED = {
  motorwayMain: 4.2,
  motorwaySlip: 2.1,
  urban:        1.8,
};


// ════════════════════════════════════════════════════════════════
//  IMAGE ANALYSER
// ════════════════════════════════════════════════════════════════

class ImageAnalyser {

  /**
   * Resize a base64 image to fit within maxW x maxH pixels.
   * Returns { base64, mimeType } — always JPEG to minimise size.
   */
  static async _resizeImage(base64, mime, maxW=1120, maxH=1120) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        // Scale down if needed
        const scale = Math.min(1, maxW / width, maxH / height);
        width  = Math.round(width  * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        // Export as JPEG at 0.88 quality — much smaller than PNG
        const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
        resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
      };
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = `data:${mime};base64,${base64}`;
    });
  }

  static async analyse(imageBase64, mimeType, canvasW, canvasH, apiKey) {
    // Always resize before sending — prevents 400 errors from oversized screenshots
    const resized = await ImageAnalyser._resizeImage(imageBase64, mimeType);
    imageBase64 = resized.base64;
    mimeType    = resized.mimeType;
    const systemPrompt = `You are a traffic engineering AI that analyses road map screenshots.
Determine whether the image shows:
  (a) an INTERSECTION/ROUNDABOUT — roads meeting at a point with signals or give-way rules
  (b) a MOTORWAY JUNCTION — high-speed divided highway with slip roads / on-ramps / off-ramps

Key signals for motorway: highway numbers (Ma-20, M25, A1 etc), divided carriageways, no traffic lights, slip roads branching off.

Respond ONLY with valid JSON — no markdown, no explanation.

For INTERSECTIONS:
{
  "mode": "intersection",
  "intersectionType": "4-way" | "T-junction" | "roundabout" | "complex",
  "roads": [
    { "id": <int>, "angleDeg": <0-359, 0=east 90=north>, "lanesIn": <1-4>, "lanesOut": <1-4>, "hasTrafficLight": <bool>, "hasCrosswalk": <bool>, "roadType": "major"|"minor" }
  ],
  "hasCentralIsland": <bool>,
  "speedLimitKmh": <int>,
  "features": [<up to 5 strings>],
  "confidence": <0-1>
}

For MOTORWAY JUNCTIONS:
{
  "mode": "motorway",
  "junctionType": "diamond"|"cloverleaf"|"trumpet"|"interchange"|"simple-merge"|"other",
  "mainRoads": [
    { "id": <int>, "name": <string>, "angleDeg": <0-359>, "lanesEachWay": <1-4>, "speedLimitKmh": <int>, "roadType": "motorway"|"dual-carriageway"|"expressway" }
  ],
  "slipRoads": [
    { "id": <int>, "type": "on-ramp"|"off-ramp"|"merge"|"diverge", "fromMainRoadId": <int|null>, "toMainRoadId": <int|null>, "angleDeg": <0-359>, "lengthEstimate": "short"|"medium"|"long", "hasMergingConflict": <bool> }
  ],
  "hasAccelerationLanes": <bool>,
  "hasDecelerationLanes": <bool>,
  "speedLimitKmh": <int>,
  "features": [<up to 5 strings>],
  "confidence": <0-1>
}`;

    const response = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role:'user', content:[
          { type:'image', source:{ type:'base64', media_type:mimeType, data:imageBase64 } },
          { type:'text',  text:'Analyse this road map image and return the JSON.' }
        ]}]
      })
    });

    if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const raw  = data.content.map(b=>b.text||'').join('');
    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g,'').trim()); }
    catch(e) { throw new Error('JSON parse failed: '+raw.slice(0,120)); }
    return parsed.mode==='motorway'
      ? ImageAnalyser._buildMotorway(parsed, canvasW, canvasH)
      : ImageAnalyser._buildIntersection(parsed, canvasW, canvasH);
  }

  static _buildIntersection(data, W, H) {
    const cx=W/2, cy=H/2, reach=Math.min(W,H)*0.42;
    let roads=(data.roads||[]).map(r=>{
      const rad=(r.angleDeg||0)*Math.PI/180;
      return { id:r.id, angleDeg:r.angleDeg||0, angleRad:rad,
        lanesIn:Math.max(1,Math.min(4,r.lanesIn||1)), lanesOut:Math.max(1,Math.min(4,r.lanesOut||1)),
        hasSignal:r.hasTrafficLight||false, hasCrosswalk:r.hasCrosswalk||false, roadType:r.roadType||'minor',
        ex:cx+Math.cos(rad)*reach, ey:cy-Math.sin(rad)*reach,
        ix:cx+Math.cos(rad)*55,    iy:cy-Math.sin(rad)*55 };
    });
    if (roads.length<2) roads=ImageAnalyser._defaultRoads(cx,cy,reach);
    return { mode:'intersection', intersectionType:data.intersectionType||'4-way',
      roads, cx, cy, reach, hasCentralIsland:data.hasCentralIsland||false,
      speedLimit:data.speedLimitKmh||50, features:data.features||[], confidence:data.confidence||0.6 };
  }

  static _buildMotorway(data, W, H) {
    const cx=W/2, cy=H/2;
    let mainRoads=(data.mainRoads||[]).map((r,i)=>{
      const rad=(r.angleDeg||(i===0?0:90))*Math.PI/180;
      const len=Math.min(W,H)*0.48;
      return { id:r.id??i, name:r.name||`Road ${i+1}`, angleRad:rad, angleDeg:r.angleDeg||0,
        lanesEachWay:Math.max(1,Math.min(4,r.lanesEachWay||2)),
        speedLimit:r.speedLimitKmh||data.speedLimitKmh||100, roadType:r.roadType||'motorway',
        x1:cx-Math.cos(rad)*len, y1:cy+Math.sin(rad)*len,
        x2:cx+Math.cos(rad)*len, y2:cy-Math.sin(rad)*len };
    });
    if (!mainRoads.length) {
      const len=Math.min(W,H)*0.48;
      mainRoads=[
        { id:0, name:'Highway A', angleRad:0,           angleDeg:0,   lanesEachWay:3, speedLimit:120, roadType:'motorway', x1:0,y1:cy,x2:W,y2:cy },
        { id:1, name:'Highway B', angleRad:Math.PI*0.6, angleDeg:108, lanesEachWay:2, speedLimit:100, roadType:'dual-carriageway', x1:cx+W*0.35,y1:0,x2:cx-W*0.35,y2:H },
      ];
    }
    const slipRoads=(data.slipRoads||[]).map((s,i)=>{
      const fromRoad=mainRoads.find(r=>r.id===s.fromMainRoadId)||mainRoads[0];
      const rad=(s.angleDeg||45)*Math.PI/180;
      const slipLen=s.lengthEstimate==='long'?190:s.lengthEstimate==='short'?85:130;
      const t=0.25+Math.random()*0.5;
      const bx=fromRoad.x1+(fromRoad.x2-fromRoad.x1)*t;
      const by=fromRoad.y1+(fromRoad.y2-fromRoad.y1)*t;
      return { id:i, type:s.type||'on-ramp', fromRoadId:s.fromMainRoadId??0, toRoadId:s.toMainRoadId??1,
        hasMergeConflict:s.hasMergingConflict||false, bx, by,
        tx:bx+Math.cos(rad)*slipLen, ty:by-Math.sin(rad)*slipLen, slipLen };
    });
    if (!slipRoads.length && mainRoads.length>=1) {
      const mr=mainRoads[0];
      const mx=(mr.x1+mr.x2)/2, my=(mr.y1+mr.y2)/2;
      slipRoads.push(
        { id:0,type:'off-ramp',fromRoadId:0,toRoadId:1,hasMergeConflict:false, bx:mx-80,by:my, tx:mx-80,ty:my-120,slipLen:120 },
        { id:1,type:'on-ramp', fromRoadId:1,toRoadId:0,hasMergeConflict:true,  bx:mx+80,by:my, tx:mx+80,ty:my-120,slipLen:120 },
      );
    }
    return { mode:'motorway', junctionType:data.junctionType||'interchange',
      mainRoads, slipRoads, cx, cy,
      speedLimit:data.speedLimitKmh||120, features:data.features||[], confidence:data.confidence||0.6 };
  }

  static _defaultRoads(cx, cy, reach) {
    return [0,90,180,270].map((deg,i)=>{
      const rad=deg*Math.PI/180;
      return { id:i, angleDeg:deg, angleRad:rad, lanesIn:2, lanesOut:2,
        hasSignal:true, hasCrosswalk:true, roadType:'major',
        ex:cx+Math.cos(rad)*reach, ey:cy-Math.sin(rad)*reach,
        ix:cx+Math.cos(rad)*55, iy:cy-Math.sin(rad)*55 };
    });
  }

  static fallbackNetwork(W, H, isMotorway=false) {
    if (isMotorway) return ImageAnalyser._buildMotorway({ mode:'motorway', features:['Fallback motorway — add API key for AI analysis'] }, W, H);
    return ImageAnalyser._buildIntersection({ mode:'intersection', features:['Fallback 4-way — add API key for AI analysis'] }, W, H);
  }
}


// ════════════════════════════════════════════════════════════════
//  TRAFFIC SIGNAL
// ════════════════════════════════════════════════════════════════

class TrafficSignal {
  constructor(roads, timing) {
    this.roads=roads; this.timing=timing;
    this.phases=this._buildPhases(); this.phaseIdx=0; this.timer=0; this.states={};
    this._apply();
  }
  _buildPhases() {
    if (this.timing==='none') return [this.roads.map(r=>r.id)];
    const used=new Set(), phases=[];
    for (let i=0;i<this.roads.length;i++) {
      if(used.has(i)) continue;
      let opp=-1;
      for(let j=i+1;j<this.roads.length;j++) {
        if(used.has(j)) continue;
        if(Math.abs(Math.abs(this.roads[i].angleDeg-this.roads[j].angleDeg)-180)<45){opp=j;break;}
      }
      const phase=[this.roads[i].id];
      if(opp>=0){phase.push(this.roads[opp].id);used.add(opp);}
      used.add(i); phases.push(phase);
    }
    return phases.length?phases:[this.roads.map(r=>r.id)];
  }
  _duration() {
    if(this.timing==='none') return Infinity;
    if(this.timing==='fixed30') return 30;
    if(this.timing==='fixed60') return 60;
    const g=this.phases[this.phaseIdx];
    return 18+g.reduce((s,id)=>{const r=this.roads.find(r=>r.id===id);return s+(r?r.lanesIn:1);},0)*5;
  }
  _apply() {
    if(this.timing==='none'){this.roads.forEach(r=>{this.states[r.id]='green';});return;}
    const gs=new Set(this.phases[this.phaseIdx]);
    this.roads.forEach(r=>{this.states[r.id]=gs.has(r.id)?'green':'red';});
  }
  isGreen(id){return this.timing==='none'||this.states[id]==='green';}
  step(dt){
    if(this.timing==='none') return;
    this.timer+=dt;
    if(this.timer>=this._duration()){this.timer=0;this.phaseIdx=(this.phaseIdx+1)%this.phases.length;this._apply();}
  }
}


// ════════════════════════════════════════════════════════════════
//  VEHICLE
// ════════════════════════════════════════════════════════════════

class Vehicle {
  constructor(id, network, entryInfo, rules, signal) {
    this.id=id; this.network=network; this.rules=rules; this.signal=signal;
    this.state='MOVING'; this.colour='#4ade80'; this.speed=0;
    this.waitTime=0; this.totalTime=0; this.x=0; this.y=0; this.angle=0;
    this.path=[]; this.pathIdx=0; this.hesTimer=0; this.mergeDelay=0;
    if (network.mode==='motorway') this._initMotorway(entryInfo);
    else this._initIntersection(entryInfo);
  }

  _initIntersection({roadIdx}) {
    const net=this.network, er=net.roads[roadIdx];
    const exits=net.roads.filter((_,i)=>i!==roadIdx);
    const xr=exits[Math.floor(Math.random()*exits.length)]||er;
    this.entryRoad=er; this.exitRoad=xr;
    const perpIn=er.angleRad+Math.PI/2, perpOut=xr.angleRad+Math.PI/2;
    // RIGHT-HAND TRAFFIC:
    // Approaching the junction: vehicle is on RIGHT side of its road = +perp offset
    // (road points FROM external endpoint TO junction, so +perp = right of travel direction)
    const inOff=LANE_W*(Math.floor(Math.random()*er.lanesIn)+0.5);
    // Exiting the junction: vehicle travels AWAY from junction along exit road
    // Direction of travel is now REVERSED relative to the road definition
    // So right-hand side = NEGATIVE perp offset
    const outOff=LANE_W*(Math.floor(Math.random()*xr.lanesOut)+0.5);
    this.x=er.ex+Math.cos(perpIn)*inOff; this.y=er.ey-Math.sin(perpIn)*inOff;
    this.speed=SPEED.urban;
    this.hesTimer=Math.max(0,this.rules.hesitationMean*(0.5+Math.random()));
    this.path=[
      { x:er.ix+Math.cos(perpIn)*inOff,   y:er.iy-Math.sin(perpIn)*inOff,   action:'STOP_CHECK', speed:SPEED.urban    },
      { x:net.cx+(Math.random()-0.5)*14,   y:net.cy+(Math.random()-0.5)*14,  action:'CROSS',      speed:SPEED.urban*0.7 },
      { x:xr.ix-Math.cos(perpOut)*outOff,  y:xr.iy+Math.sin(perpOut)*outOff, action:'EXIT',       speed:SPEED.urban    },
      { x:xr.ex-Math.cos(perpOut)*outOff,  y:xr.ey+Math.sin(perpOut)*outOff, action:'DONE',       speed:SPEED.urban    },
    ];
  }

  _initMotorway({routeType, mainRoadId, slipId}) {
    const net=this.network;
    this.routeType=routeType;

    if (routeType==='through') {
      const road=net.mainRoads.find(r=>r.id===mainRoadId)||net.mainRoads[0];
      const perp=road.angleRad+Math.PI/2;
      const lane=Math.floor(Math.random()*road.lanesEachWay);
      // RIGHT-HAND TRAFFIC:
      // Carriageway A (dir +1, x1→x2): vehicles sit on the +perp side of centreline
      // Carriageway B (dir -1, x2→x1): vehicles sit on the -perp side of centreline
      // +perp is LEFT of forward direction when facing x1→x2 in screen coords...
      // Actually: perp = angleRad+π/2. When road goes NE (angleRad~45°), perp points NW.
      // For right-hand traffic going NE, vehicles should be on the SE side = -perp direction.
      // Rule: dir=+1 goes x1→x2, sits on -perp side. dir=-1 goes x2→x1, sits on +perp side.
      const dir=Math.random()<0.5?1:-1;
      const off=(LANE_W*(lane+0.5)+5)*(-dir); // negative = right of travel
      this.x=(dir>0?road.x1:road.x2)+Math.cos(perp)*off;
      this.y=(dir>0?road.y1:road.y2)-Math.sin(perp)*off;
      const ex=(dir>0?road.x2:road.x1)+Math.cos(perp)*off;
      const ey=(dir>0?road.y2:road.y1)-Math.sin(perp)*off;
      this.speed=SPEED.motorwayMain*(0.85+Math.random()*0.3);
      this.angle=Math.atan2(ey-this.y, ex-this.x);
      this.routeDir=dir;    // store for _near filtering
      this.roadId=road.id;
      this.isOnSlip=false;
      this.path=[{ x:ex, y:ey, action:'DONE', speed:this.speed }];

    } else if (routeType==='exit') {
      const slip=net.slipRoads.find(s=>s.id===slipId)||net.slipRoads[0];
      if (!slip){this._initMotorway({routeType:'through',mainRoadId:0,slipId:0});return;}
      const road=net.mainRoads.find(r=>r.id===slip.fromRoadId)||net.mainRoads[0];
      const perp=road.angleRad+Math.PI/2;
      // Which side of centreline is the branch point on?
      const perpDot=(slip.bx-road.x1)*Math.cos(perp)-(slip.by-road.y1)*Math.sin(perp);
      const side=perpDot>=0?1:-1; // +1 = +perp side, -1 = -perp side
      // For right-hand traffic, that side determines which direction was travelling this carriageway
      // dir going x1→x2 sits on -perp side, dir going x2→x1 sits on +perp side
      const dir=side>0?-1:1; // +perp side = dir -1
      const off=(LANE_W*0.5+5)*(-dir);
      const d1=Math.hypot(road.x1-slip.bx, road.y1-slip.by);
      const d2=Math.hypot(road.x2-slip.bx, road.y2-slip.by);
      const spawnX=(d1>d2?road.x1:road.x2), spawnY=(d1>d2?road.y1:road.y2);
      this.x=spawnX+Math.cos(perp)*off; this.y=spawnY-Math.sin(perp)*off;
      this.speed=SPEED.motorwayMain;
      this.routeDir=dir; this.roadId=road.id; this.isOnSlip=false;
      this.angle=Math.atan2(slip.bx-this.x, slip.by-this.y);
      const curve=slip.curve||[];
      this.path=[
        { x:slip.bx+Math.cos(perp)*off, y:slip.by-Math.sin(perp)*off, action:'DECEL', speed:SPEED.motorwayMain },
        ...curve.map(p=>({ x:p.x, y:p.y, action:'MOVING', speed:SPEED.motorwaySlip })),
        { x:slip.tx, y:slip.ty, action:'DONE', speed:SPEED.motorwaySlip },
      ];

    } else { // on-ramp
      const slip=net.slipRoads.find(s=>s.id===slipId)||net.slipRoads[0];
      if (!slip){this._initMotorway({routeType:'through',mainRoadId:0,slipId:0});return;}
      const road=net.mainRoads.find(r=>r.id===slip.toRoadId)||net.mainRoads[0];
      const perp=road.angleRad+Math.PI/2;
      const perpDot=(slip.bx-road.x1)*Math.cos(perp)-(slip.by-road.y1)*Math.sin(perp);
      const side=perpDot>=0?1:-1;
      const dir=side>0?-1:1;
      const off=(LANE_W*0.5+5)*(-dir);
      const d1=Math.hypot(road.x1-slip.bx, road.y1-slip.by);
      const d2=Math.hypot(road.x2-slip.bx, road.y2-slip.by);
      const exitX=(d1>d2?road.x1:road.x2), exitY=(d1>d2?road.y1:road.y2);
      this.x=slip.tx; this.y=slip.ty;
      this.mergeDelay=slip.hasMergeConflict?this.rules.conflictFactor*(1+Math.random()*2):0;
      this.speed=SPEED.motorwaySlip;
      this.routeDir=dir; this.roadId=road.id; this.isOnSlip=true;
      const curve=slip.curve||[];
      this.path=[
        ...[...curve].reverse().map(p=>({ x:p.x, y:p.y, action:'MOVING', speed:SPEED.motorwaySlip })),
        { x:slip.bx+Math.cos(perp)*off, y:slip.by-Math.sin(perp)*off, action:'MERGE', speed:SPEED.motorwaySlip },
        { x:exitX+Math.cos(perp)*off,   y:exitY-Math.sin(perp)*off,   action:'DONE',  speed:SPEED.motorwayMain },
      ];
    }
  }

  step(dt, allVehicles) {
    this.totalTime+=dt;
    const target=this.path[this.pathIdx];
    if (!target||this.state==='DONE'){this.state='DONE';return;}
    const dx=target.x-this.x, dy=target.y-this.y, dist=Math.hypot(dx,dy);

    if (dist<5) {
      if (target.action==='DONE'){this.state='DONE';return;}
      if (target.action==='STOP_CHECK'){this._stopCheck(allVehicles,dt);return;}
      if (target.action==='MERGE'){
        if(this.mergeDelay>0){this.mergeDelay-=dt;this.waitTime+=dt;this.state='WAITING';this._col();return;}
      }
      this.pathIdx++; this._col(); return;
    }

    this.angle=Math.atan2(dy,dx);
    const tspd=target.speed||this.speed;
    const near=this._near(allVehicles);
    let spd=tspd;
    if(near<22){spd=tspd*Math.max(0.02,(near-8)/14);this.state=near<10?'STOPPED':'SLOWING';}
    else{this.speed=Math.min(tspd,this.speed+0.05);spd=this.speed;this.state='MOVING';}
    spd*=(0.94+Math.random()*0.12)*(dt*FPS);
    this.x+=dx/dist*spd; this.y+=dy/dist*spd; this._col();
  }

  _stopCheck(allVehicles,dt) {
    this.state='WAITING'; this.waitTime+=dt;
    const ok=this.signal?(this.signal.isGreen(this.entryRoad?.id)&&this._clear(allVehicles)):this._clear(allVehicles);
    if(ok){this.hesTimer-=dt;if(this.hesTimer<=0){this.pathIdx++;this.state='MOVING';}}
    else{this.hesTimer=Math.max(this.hesTimer,this.rules.hesitationMean*(0.6+Math.random()*0.8));}
    this._col();
  }
  _clear(allVehicles) {
    const cx=this.network.cx,cy=this.network.cy;
    for(const v of allVehicles){if(v===this||v.state==='DONE')continue;if(v.state==='MOVING'&&Math.hypot(v.x-cx,v.y-cy)<45)return false;}
    return true;
  }
  _near(allVehicles) {
    const cos=Math.cos(this.angle), sin=Math.sin(this.angle);
    let m=Infinity;
    for(const v of allVehicles){
      if(v===this||v.state==='DONE') continue;
      // In motorway mode: ignore vehicles on a different carriageway or slip road
      // (they are on a bridge/tunnel over/under us, or going opposite direction)
      if(this.network.mode==='motorway'){
        // Same direction carriageway only — skip if different routeDir
        if(this.routeDir!==undefined && v.routeDir!==undefined){
          // Through traffic: only interact with same direction
          if(this.routeType==='through' && v.routeType==='through' && v.routeDir!==this.routeDir) continue;
          // Slip road vehicles interact with each other and with merging through traffic
          if(this.isOnSlip && v.isOnSlip===false && v.routeDir!==this.routeDir) continue;
        }
      }
      const vx=v.x-this.x, vy=v.y-this.y;
      if(vx*cos+vy*sin<0) continue; // behind us
      const d=Math.hypot(vx,vy);
      if(d<m) m=d;
    }
    return m;
  }
  _col(){
    if(this.state==='STOPPED'||this.state==='WAITING')this.colour='#f87171';
    else if(this.state==='SLOWING')this.colour='#facc15';
    else this.colour='#4ade80';
  }
}


// ════════════════════════════════════════════════════════════════
//  METRICS TRACKER
// ════════════════════════════════════════════════════════════════

class MetricsTracker {
  constructor(){this.completed=0;this.totalWait=0;this.history={queue:[],throughput:[],wait:[],speed:[]};this._recent=[];this._tick=0;}
  record(vehicles,simTime){
    this._tick++;if(this._tick%FPS!==0)return;
    const q=vehicles.filter(v=>v.state==='WAITING'||v.state==='STOPPED').length;
    const avg=this.completed>0?this.totalWait/this.completed:0;
    this._recent=this._recent.filter(t=>t>=simTime-60);
    this._push('queue',q);this._push('throughput',this._recent.length);this._push('wait',avg);
    this._push('speed',vehicles.length?vehicles.reduce((s,v)=>s+(v.speed||0),0)/vehicles.length*10:0);
  }
  onComplete(v){this.completed++;this.totalWait+=v.waitTime;this._recent.push(v.totalTime);}
  _push(k,v){this.history[k].push(v);if(this.history[k].length>150)this.history[k].shift();}
  snapshot(vehicles){
    const q=vehicles.filter(v=>v.state==='WAITING'||v.state==='STOPPED').length;
    const avg=this.completed>0?this.totalWait/this.completed:0;
    const circ=vehicles.filter(v=>v.state==='MOVING');
    let risk=0;
    for(let i=0;i<circ.length;i++)for(let j=i+1;j<circ.length;j++)if(Math.hypot(circ[i].x-circ[j].x,circ[i].y-circ[j].y)<18)risk++;
    return{throughput:this._recent.length,avgWait:avg,queue:q,risk:Math.min(1,risk*0.12),total:vehicles.length};
  }
  exportCSV(){
    const rows=['tick,queue,throughput,avg_wait_s,speed_index'];
    const len=Math.max(...Object.values(this.history).map(a=>a.length),0);
    for(let i=0;i<len;i++)rows.push([i,this.history.queue[i]??'',this.history.throughput[i]??'',(this.history.wait[i]??0).toFixed(2),(this.history.speed[i]??0).toFixed(1)].join(','));
    return rows.join('\n');
  }
}


// ════════════════════════════════════════════════════════════════
//  RENDERER
// ════════════════════════════════════════════════════════════════

class Renderer {
  constructor(canvas,network){this.canvas=canvas;this.ctx=canvas.getContext('2d');this.network=network;this.W=canvas.width;this.H=canvas.height;}

  clear(){
    const ctx=this.ctx;
    ctx.fillStyle='#dce8d0';ctx.fillRect(0,0,this.W,this.H);
    ctx.strokeStyle='rgba(160,180,150,0.35)';ctx.lineWidth=1;
    for(let x=0;x<this.W;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,this.H);ctx.stroke();}
    for(let y=0;y<this.H;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(this.W,y);ctx.stroke();}
  }

  drawRoads(signal){
    this.network.mode==='motorway'?this._motorway():this._intersection(signal);
  }

  _intersection(signal){
    const ctx=this.ctx,net=this.network;
    net.roads.forEach(road=>{
      const tW=(road.lanesIn+road.lanesOut)*LANE_W+6,reach=Math.hypot(road.ex-net.cx,road.ey-net.cy);
      const perp=road.angleRad+Math.PI/2;
      ctx.save();ctx.translate(net.cx,net.cy);ctx.rotate(-road.angleRad);
      ctx.fillStyle='#c8d8b8';ctx.fillRect(0,-tW/2-8,reach,tW+16);
      ctx.fillStyle=road.roadType==='major'?'#8a9099':'#9aa0ad';ctx.fillRect(0,-tW/2,reach,tW);
      ctx.strokeStyle='rgba(255,255,255,0.9)';ctx.lineWidth=2;ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(30,-tW/2);ctx.lineTo(reach,-tW/2);ctx.stroke();
      ctx.beginPath();ctx.moveTo(30,tW/2);ctx.lineTo(reach,tW/2);ctx.stroke();
      ctx.strokeStyle='#f0c040';ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(0,-1.5);ctx.lineTo(reach,-1.5);ctx.stroke();
      ctx.beginPath();ctx.moveTo(0,1.5);ctx.lineTo(reach,1.5);ctx.stroke();
      ctx.strokeStyle='rgba(255,255,255,0.7)';ctx.lineWidth=1;ctx.setLineDash([10,10]);
      for(let l=1;l<road.lanesIn;l++){ctx.beginPath();ctx.moveTo(30,l*LANE_W);ctx.lineTo(reach,l*LANE_W);ctx.stroke();}
      for(let l=1;l<road.lanesOut;l++){ctx.beginPath();ctx.moveTo(30,-l*LANE_W);ctx.lineTo(reach,-l*LANE_W);ctx.stroke();}
      ctx.setLineDash([]);ctx.restore();
      if(road.hasSignal&&signal){
        const col=signal.states[road.id]==='green'?'#16a34a':'#dc2626';
        const sx=road.ix+Math.cos(road.angleRad)*18+Math.cos(perp)*20,sy=road.iy-Math.sin(road.angleRad)*18-Math.sin(perp)*20;
        ctx.beginPath();ctx.arc(sx,sy,8,0,Math.PI*2);ctx.fillStyle='#222';ctx.fill();
        ctx.beginPath();ctx.arc(sx,sy,5,0,Math.PI*2);ctx.fillStyle=col;ctx.fill();
        ctx.beginPath();ctx.arc(sx,sy,11,0,Math.PI*2);ctx.fillStyle=col+'44';ctx.fill();
      }
    });
    const hw=net.roads.reduce((m,r)=>Math.max(m,(r.lanesIn+r.lanesOut)*LANE_W+6),40);
    if(net.intersectionType==='roundabout'){
      ctx.beginPath();ctx.arc(net.cx,net.cy,58,0,Math.PI*2);ctx.fillStyle='#9aa0ad';ctx.fill();
      ctx.beginPath();ctx.arc(net.cx,net.cy,22,0,Math.PI*2);ctx.fillStyle='#5a8a5e';ctx.fill();
    }else{ctx.fillStyle='#9aa0ad';ctx.fillRect(net.cx-hw,net.cy-hw,hw*2,hw*2);}
  }

  _motorway(){
    const ctx=this.ctx,net=this.network;
    net.mainRoads.forEach(road=>{
      const perp=road.angleRad+Math.PI/2,lanes=road.lanesEachWay;
      const halfW=lanes*LANE_W+4,totalW=halfW*2+8;
      const len=Math.hypot(road.x2-road.x1,road.y2-road.y1);
      ctx.save();ctx.translate(road.x1,road.y1);ctx.rotate(-road.angleRad);
      // Verge
      ctx.fillStyle='#c8d8b8';ctx.fillRect(0,-totalW/2-14,len,totalW+28);
      // Carriageways
      ctx.fillStyle=road.roadType==='motorway'?'#7a8599':'#8a9099';
      ctx.fillRect(0,4,len,halfW);ctx.fillRect(0,-halfW-4,len,halfW);
      // Central reservation
      ctx.fillStyle='#c8d8b8';ctx.fillRect(0,-4,len,8);
      ctx.strokeStyle='rgba(130,160,120,0.7)';ctx.lineWidth=1;
      for(let x=0;x<len;x+=18){ctx.beginPath();ctx.moveTo(x,-4);ctx.lineTo(x+9,4);ctx.stroke();}
      // Edge lines
      ctx.strokeStyle='rgba(255,255,255,0.95)';ctx.lineWidth=2;ctx.setLineDash([]);
      [4+halfW,-4-halfW].forEach(y=>{ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(len,y);ctx.stroke();});
      // Lane dashes
      ctx.strokeStyle='rgba(255,255,255,0.6)';ctx.lineWidth=1.2;ctx.setLineDash([20,14]);
      for(let l=1;l<lanes;l++){
        ctx.beginPath();ctx.moveTo(0,4+l*LANE_W);ctx.lineTo(len,4+l*LANE_W);ctx.stroke();
        ctx.beginPath();ctx.moveTo(0,-4-l*LANE_W);ctx.lineTo(len,-4-l*LANE_W);ctx.stroke();
      }
      ctx.setLineDash([]);
      // Direction arrows on carriageway (every ~120px)
      ctx.fillStyle='rgba(255,255,255,0.25)';
      const arrowSpacing=120;
      for(let d=arrowSpacing;d<len-20;d+=arrowSpacing){
        // Lower carriageway (dir x1→x2): arrow pointing right (+x in local coords)
        ctx.save();ctx.translate(d,4+halfW*0.5);
        ctx.beginPath();ctx.moveTo(7,0);ctx.lineTo(-3,-4);ctx.lineTo(-3,4);ctx.closePath();ctx.fill();
        ctx.restore();
        // Upper carriageway (dir x2→x1): arrow pointing left (-x)
        ctx.save();ctx.translate(d,-4-halfW*0.5);
        ctx.beginPath();ctx.moveTo(-7,0);ctx.lineTo(3,-4);ctx.lineTo(3,4);ctx.closePath();ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    });
    // Slip roads — drawn as polylines through user-marked points
    net.slipRoads.forEach(slip=>{
      const pts=slip.renderPts||[{x:slip.bx,y:slip.by},{x:slip.tx,y:slip.ty}];
      if(pts.length<2)return;
      const slipW=LANE_W+4;

      // Build a smooth path through all points
      ctx.save();
      // Verge/shadow
      ctx.strokeStyle='#b8c8a8'; ctx.lineWidth=slipW+10; ctx.lineJoin='round'; ctx.lineCap='round'; ctx.setLineDash([]);
      ctx.beginPath(); pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y)); ctx.stroke();
      // Road surface
      ctx.strokeStyle='#9aa0ad'; ctx.lineWidth=slipW;
      ctx.beginPath(); pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y)); ctx.stroke();
      // Edge highlight
      ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=1;
      ctx.beginPath(); pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y)); ctx.stroke();
      ctx.restore();

      // Label near midpoint
      const mid=pts[Math.floor(pts.length/2)];
      ctx.fillStyle='rgba(40,40,40,0.7)';ctx.font='9px monospace';ctx.textAlign='left';
      ctx.fillText(slip.type, mid.x+4, mid.y-6);

      // Direction arrow at ~55% along path
      const totalSegs=pts.length-1;
      const targetSeg=Math.floor(totalSegs*0.55);
      const p0=pts[Math.min(targetSeg,pts.length-2)];
      const p1=pts[Math.min(targetSeg+1,pts.length-1)];
      const adx=p1.x-p0.x, ady=p1.y-p0.y;
      const isOnRamp=slip.type==='on-ramp'||slip.type==='merge';
      const arrowAngle=isOnRamp?Math.atan2(-ady,-adx):Math.atan2(ady,adx);
      const ax=(p0.x+p1.x)/2, ay=(p0.y+p1.y)/2;
      ctx.save();ctx.translate(ax,ay);ctx.rotate(arrowAngle);
      ctx.fillStyle=isOnRamp?'#16a34a':'#d97706';
      ctx.beginPath();ctx.moveTo(9,0);ctx.lineTo(-5,-5);ctx.lineTo(-5,5);ctx.closePath();ctx.fill();
      ctx.restore();
    });
  }

  drawVehicles(vehicles){
    const ctx=this.ctx;
    vehicles.forEach(v=>{
      if(v.state==='DONE')return;
      ctx.save();ctx.translate(v.x,v.y);ctx.rotate(v.angle||0);
      ctx.shadowColor=v.colour+'88';ctx.shadowBlur=5;
      ctx.fillStyle=v.colour;ctx.strokeStyle='rgba(0,0,0,0.3)';ctx.lineWidth=0.8;
      ctx.beginPath();ctx.roundRect(-CAR_W/2,-CAR_H/2,CAR_W,CAR_H,2);ctx.fill();ctx.stroke();
      ctx.fillStyle='rgba(0,0,0,0.22)';ctx.fillRect(1,-CAR_H/2+1,CAR_W/2-2,CAR_H-2);
      ctx.shadowBlur=0;ctx.restore();
    });
  }

  drawHeatmap(vehicles){
    const ctx=this.ctx;
    vehicles.filter(v=>v.state==='STOPPED'||v.state==='WAITING').forEach(v=>{
      const g=ctx.createRadialGradient(v.x,v.y,0,v.x,v.y,40);
      g.addColorStop(0,'rgba(220,50,30,0.18)');g.addColorStop(1,'rgba(220,50,30,0)');
      ctx.fillStyle=g;ctx.beginPath();ctx.arc(v.x,v.y,40,0,Math.PI*2);ctx.fill();
    });
  }
}


// ════════════════════════════════════════════════════════════════
//  GRAPH RENDERER
// ════════════════════════════════════════════════════════════════

class GraphRenderer {
  constructor(canvas){this.canvas=canvas;this.ctx=canvas.getContext('2d');}
  draw(history,metric){
    const ctx=this.ctx,W=this.canvas.width,H=this.canvas.height,data=history[metric]||[];
    ctx.clearRect(0,0,W,H);ctx.fillStyle='#f7f8fa';ctx.fillRect(0,0,W,H);
    if(data.length<2)return;
    const max=Math.max(...data,1),pad=10,gW=W-pad*2,gH=H-pad*2;
    ctx.beginPath();ctx.moveTo(pad,H-pad);
    data.forEach((v,i)=>{ctx.lineTo(pad+(i/(data.length-1))*gW,H-pad-(v/max)*gH);});
    ctx.lineTo(W-pad,H-pad);ctx.closePath();
    const gr=ctx.createLinearGradient(0,0,0,H);gr.addColorStop(0,'rgba(217,119,6,0.35)');gr.addColorStop(1,'rgba(217,119,6,0.02)');
    ctx.fillStyle=gr;ctx.fill();
    ctx.beginPath();
    data.forEach((v,i)=>{const x=pad+(i/(data.length-1))*gW,y=H-pad-(v/max)*gH;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
    ctx.strokeStyle='#d97706';ctx.lineWidth=1.8;ctx.stroke();
    const last=data[data.length-1],lx=W-pad,ly=H-pad-(last/max)*gH;
    ctx.beginPath();ctx.arc(lx,ly,3,0,Math.PI*2);ctx.fillStyle='#d97706';ctx.fill();
  }
}


// ════════════════════════════════════════════════════════════════
//  SIMULATION
// ════════════════════════════════════════════════════════════════

class Simulation {
  constructor(network,opts){
    this.network=network;this.opts=opts;this.vehicles=[];
    this.signal=network.mode==='intersection'?new TrafficSignal(network.roads,opts.signalTiming):null;
    this.metrics=new MetricsTracker();this.simTime=0;this._nextId=0;this._spawnAcc=0;
  }
  _spawnRate(){
    const base=VOLUME_RATES[this.opts.volume]||VOLUME_RATES.medium;
    const p=TIME_PERIODS.find(p=>{const h=this.opts.timeHour;return h>=p.h[0]&&h<p.h[1];})||TIME_PERIODS[0];
    return base*p.mult*this.opts.speed;
  }
  step(dt){
    const sdt=dt*this.opts.speed;this.simTime+=sdt;
    if(this.signal)this.signal.step(sdt);
    this._spawnAcc+=sdt;
    const iv=1/Math.max(this._spawnRate(),0.01);
    while(this._spawnAcc>=iv){this._spawnAcc-=iv;this._spawnVehicle();}
    for(const v of this.vehicles)v.step(sdt,this.vehicles);
    const done=this.vehicles.filter(v=>v.state==='DONE');
    done.forEach(v=>this.metrics.onComplete(v));
    this.vehicles=this.vehicles.filter(v=>v.state!=='DONE');
    if(this.vehicles.length>140)this.vehicles.splice(0,5);
    this.metrics.record(this.vehicles,this.simTime);
  }
  _spawnVehicle(){
    const rules=RULE_SYSTEMS[this.opts.ruleSystem]||RULE_SYSTEMS.uk;
    if(this.network.mode==='motorway'){
      const net=this.network,mains=net.mainRoads,slips=net.slipRoads;
      if(!mains.length)return;
      const r=Math.random();
      if(slips.length>0&&r>0.60){
        if(r>0.80){
          const on=slips.filter(s=>s.type==='on-ramp'||s.type==='merge');
          const s=on.length?on[Math.floor(Math.random()*on.length)]:slips[0];
          this.vehicles.push(new Vehicle(this._nextId++,net,{routeType:'enter',slipId:s.id,mainRoadId:0},rules,null));
        }else{
          const off=slips.filter(s=>s.type==='off-ramp'||s.type==='diverge');
          const s=off.length?off[Math.floor(Math.random()*off.length)]:slips[0];
          this.vehicles.push(new Vehicle(this._nextId++,net,{routeType:'exit',slipId:s.id,mainRoadId:0},rules,null));
        }
      }else{
        const road=mains[Math.floor(Math.random()*mains.length)];
        this.vehicles.push(new Vehicle(this._nextId++,net,{routeType:'through',mainRoadId:road.id,slipId:0},rules,null));
      }
    }else{
      const roads=this.network.roads;if(!roads.length)return;
      this.vehicles.push(new Vehicle(this._nextId++,this.network,{roadIdx:Math.floor(Math.random()*roads.length)},rules,this.signal));
    }
  }
  updateOpts(opts){
    this.opts={...this.opts,...opts};
    if(opts.signalTiming&&this.network.mode==='intersection')this.signal=new TrafficSignal(this.network.roads,opts.signalTiming);
  }
  getSnapshot(){return this.metrics.snapshot(this.vehicles);}
}


// ════════════════════════════════════════════════════════════════
//  APP CONTROLLER
// ════════════════════════════════════════════════════════════════

class AppController {
  constructor(){
    this.network=null;this.simulation=null;this.renderer=null;this.graphRdr=null;
    this.animId=null;this.simTime=0;
    this.opts={volume:'medium',timeHour:8,signalTiming:'adaptive',ruleSystem:'uk',speed:1};
    // Road marking tool state
    // Each road = { outer:{x,y,dx,dy}, inner:{x,y,dx,dy} }
    // Clicking alternates: outer(A/B/C) then inner(1/2/3)
    this._roads = [];
    this._pendingOuter = null;
    this._pendingInner = null;
    this._motorwayLine = null;   // {p1, p2} — the two M clicks
    this._imgNaturalW=1; this._imgNaturalH=1;
    this._markingMode = 'intersection'; // 'intersection' | 'motorway'
    this._bindUI();
  }

  _markColour(i){
    return ['#e53e3e','#d97706','#16a34a','#2563eb','#7c3aed','#db2777'][i%6];
  }

  _updateMarkBadge(){
    const badge=document.getElementById('markModeBadge');
    const label=document.getElementById('markModeLabel');
    const instr=document.getElementById('markInstructions');
    if(!badge)return;
    const n=this._roads.length;

    if(this._markingMode==='motorway'){
      if(!this._motorwayLine){
        // Step 1: mark the motorway itself
        instr.innerHTML='<strong>Step 1:</strong> Click one end of the <strong>main motorway</strong> (<strong>M</strong>), then the other end (<strong>M</strong>). This sets the carriageway direction.';
        if(!this._pendingOuter){
          badge.textContent='M'; badge.style.background='#1d4ed8';
          label.textContent='Click one end of the motorway';
        }else{
          badge.textContent='M'; badge.style.background='#1d4ed8';
          label.textContent='Now click the OTHER end of the motorway';
        }
      }else{
        // Step 2: mark slip roads
        instr.innerHTML='<strong>Step 2:</strong> For each slip road: click its <strong>tip</strong> (A, B…) then where it <strong>meets the motorway</strong> (1, 2…). Then choose exit or on-ramp.';
        if(this._pendingOuter){
          badge.textContent=String(n+1); badge.style.background=this._markColour(n);
          label.textContent=`Click where slip ${String.fromCharCode(65+n)} meets the motorway`;
        }else{
          badge.textContent=String.fromCharCode(65+n);
          badge.style.background=this._markColour(n);
          label.textContent=n===0
            ?'Click the tip of the first slip road'
            :`Click tip of slip ${String.fromCharCode(65+n)} (or Build if done)`;
        }
      }
    }else{
      instr.innerHTML='Click the <strong>outer end</strong> of a road (A, B, C…) then where it <strong>meets the junction</strong> (1, 2, 3…).';
      if(this._pendingOuter){
        badge.textContent=String(n+1);
        badge.style.background=this._markColour(n);
        label.textContent=`Now click where road ${String.fromCharCode(65+n)} meets the junction`;
      }else{
        badge.textContent=String.fromCharCode(65+n);
        badge.style.background=n===0?'var(--accent)':this._markColour(n);
        label.textContent=n===0
          ?'Click the outer end of the first road'
          :`Click outer end of road ${String.fromCharCode(65+n)} (or Build when done)`;
      }
    }
  }

  _buildFromMarkedPoints(canvasW, canvasH){
    const roads=this._roads;
    if(roads.length<1)return null;
    const cx=canvasW/2, cy=canvasH/2;
    const sx=canvasW/this._imgNaturalW, sy=canvasH/this._imgNaturalH;

    if(this._markingMode==='motorway'){
      let mainAngle=0, x1,y1,x2,y2;

      if(this._motorwayLine){
        // Use the explicitly marked M→M line
        const p1=this._motorwayLine.p1, p2=this._motorwayLine.p2;
        x1=p1.x*sx; y1=p1.y*sy;
        x2=p2.x*sx; y2=p2.y*sy;
        mainAngle=Math.atan2(-(y2-y1),(x2-x1));
      }else{
        // Fallback: guess from slip road inner points
        const avgDx=roads.reduce((s,r)=>s+(r.inner.x*sx-cx),0)/roads.length;
        const avgDy=roads.reduce((s,r)=>s+(r.inner.y*sy-cy),0)/roads.length;
        mainAngle=Math.atan2(-avgDy,avgDx)+Math.PI/2;
        const len=Math.min(canvasW,canvasH)*0.48;
        x1=cx-Math.cos(mainAngle)*len; y1=cy+Math.sin(mainAngle)*len;
        x2=cx+Math.cos(mainAngle)*len; y2=cy-Math.sin(mainAngle)*len;
      }
      const mainRoads=[{
        id:0, name:'Main Carriageway',
        angleRad:mainAngle, angleDeg:Math.round(((mainAngle*180/Math.PI)+360)%360),
        lanesEachWay:3, speedLimit:120, roadType:'motorway',
        x1, y1, x2, y2,
      }];

      // Each marked pair becomes a slip road
      const slipRoads=roads.map((road,i)=>{
        const ox=road.outer.x*sx, oy=road.outer.y*sy;  // A click
        const ix=road.inner.x*sx, iy=road.inner.y*sy;  // last click (motorway join)
        const type=road.type||'off-ramp';

        // Scale waypoints to canvas coords
        const waypoints=(road.waypoints||[]).map(p=>({
          x:p.x*sx, y:p.y*sy,
        }));

        // All points in order: A → waypoints → 1
        // For off-ramp: bx/by = outer(A, motorway branch), tx/ty = inner(1, tip)
        //   but user clicks A=tip first, then waypoints, then 1=motorway join
        //   WAIT — user instructions: A=tip for on-ramp, A=motorway branch for off-ramp
        // Actually with the new system the user clicks A first (regardless of type),
        // then waypoints along the road, then last click = motorway join point.
        // So: outer = A (tip/start), inner = motorway join
        // For off-ramp: A = where it leaves motorway, 1 = tip → outer IS the branch
        // For on-ramp:  A = tip,                      1 = where it joins → inner IS the branch
        const bx = type==='off-ramp' ? ox : ix;
        const by = type==='off-ramp' ? oy : iy;
        const tx = type==='off-ramp' ? ix : ox;
        const ty = type==='off-ramp' ? iy : oy;

        // curve = ordered intermediate points for vehicle path (bx→...→tx)
        const rawMid=waypoints; // already in A→1 order
        const curve = type==='off-ramp'
          ? rawMid                        // bx=outer, so same order
          : [...rawMid].reverse();        // bx=inner, so reverse

        const slipLen=Math.hypot(tx-bx, ty-by);
        return {
          id:i, type,
          fromRoadId:0, toRoadId:0,
          hasMergeConflict:type==='on-ramp',
          bx, by, tx, ty, slipLen,
          curve,          // intermediate waypoints bx→tx order
          // Store all points for renderer (outer→waypoints→inner, in click order)
          renderPts:[{x:ox,y:oy},...waypoints,{x:ix,y:iy}],
        };
      });

      return{mode:'motorway',junctionType:'interchange',mainRoads,slipRoads,
        cx,cy,speedLimit:120,features:['Manually marked motorway junction'],confidence:1.0};

    }else{
      // Intersection mode — each pair is a road arm
      const netRoads=roads.map((road,i)=>{
        const ox=road.outer.x*sx, oy=road.outer.y*sy;
        const ix=road.inner.x*sx, iy=road.inner.y*sy;
        const dx=ix-ox, dy=iy-oy;
        const rad=Math.atan2(-dy,dx);
        const deg=((rad*180/Math.PI)+360)%360;
        return{
          id:i, angleDeg:Math.round(deg), angleRad:rad,
          lanesIn:2, lanesOut:2, hasSignal:roads.length<=4,
          hasCrosswalk:false, roadType:'major',
          ex:ox, ey:oy, ix:ix, iy:iy,
        };
      });
      const type=netRoads.length===3?'T-junction':netRoads.length===4?'4-way':'complex';
      return{mode:'intersection',intersectionType:type,roads:netRoads,cx,cy,
        reach:Math.min(canvasW,canvasH)*0.42,hasCentralIsland:false,
        speedLimit:50,features:['Manually marked intersection'],confidence:1.0};
    }
  }

  _bindUI(){
    const zone=document.getElementById('uploadZone'),input=document.getElementById('fileInput');
    zone.addEventListener('click',()=>input.click());
    zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});
    zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
    zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');if(e.dataTransfer.files[0]?.type.startsWith('image/'))this._handleFile(e.dataTransfer.files[0]);});
    input.addEventListener('change',()=>{if(input.files[0])this._handleFile(input.files[0]);});
    document.getElementById('btnReupload').addEventListener('click',()=>{
      ['previewSection','markTool','controlsSection','analysisSection'].forEach(id=>{document.getElementById(id).style.display='none';});
      document.getElementById('uploadZone').style.display='';
      document.getElementById('btnExport').style.display='none';
      this._roads=[];this._pendingOuter=null;this._pendingWaypoints=[];this._motorwayLine=null;
      this._stopSim();
    });

    // Road marking tool
    document.getElementById('mapPreviewWrap').addEventListener('click', e => this._onMapClick(e));
    document.getElementById('btnBuild').addEventListener('click', () => this._buildFromMarks());
    document.getElementById('btnMarkClear').addEventListener('click', () => {
      this._roads=[];this._pendingOuter=null;this._pendingInner=null;this._pendingWaypoints=[];this._motorwayLine=null;
      document.getElementById('slipTypePicker')?.remove();
      this._redrawOverlay();
      document.getElementById('markRoadList').innerHTML='';
      this._updateMarkBadge();
    });
    // Mode toggle
    document.getElementById('modeIntersection').addEventListener('click',()=>{
      this._markingMode='intersection';
      document.getElementById('modeIntersection').classList.add('active');
      document.getElementById('modeMotorway').classList.remove('active');
      this._roads=[];this._pendingOuter=null;this._pendingWaypoints=[];this._motorwayLine=null;
      document.getElementById('slipTypePicker')?.remove();
      this._redrawOverlay();document.getElementById('markRoadList').innerHTML='';
      this._updateMarkBadge();
    });
    document.getElementById('modeMotorway').addEventListener('click',()=>{
      this._markingMode='motorway';
      document.getElementById('modeMotorway').classList.add('active');
      document.getElementById('modeIntersection').classList.remove('active');
      this._roads=[];this._pendingOuter=null;this._pendingWaypoints=[];this._motorwayLine=null;
      document.getElementById('slipTypePicker')?.remove();
      this._redrawOverlay();document.getElementById('markRoadList').innerHTML='';
      this._updateMarkBadge();
    });

    this._bindPills('volumeBtns','volume');this._bindPills('signalBtns','signalTiming');this._bindPills('ruleBtns','ruleSystem');
    const tsl=document.getElementById('timeSlider');
    tsl.addEventListener('input',()=>{
      const h=parseInt(tsl.value);this.opts.timeHour=h;
      document.getElementById('timeLabel').textContent=String(h).padStart(2,'0')+':00';
      const p=TIME_PERIODS.find(p=>h>=p.h[0]&&h<p.h[1]);
      document.getElementById('timePeriod').textContent=p?p.label:'';
      if(this.simulation)this.simulation.updateOpts(this.opts);
    });
    const ssl=document.getElementById('speedSlider');
    ssl.addEventListener('input',()=>{
      this.opts.speed=parseFloat(ssl.value);
      document.getElementById('speedLabel').textContent=this.opts.speed+'×';
      if(this.simulation)this.simulation.updateOpts(this.opts);
    });
    document.getElementById('btnRun').addEventListener('click',()=>this._startSim());
    document.getElementById('btnPause').addEventListener('click',()=>this._togglePause());
    document.getElementById('btnExport').addEventListener('click',()=>this._exportCSV());
    document.getElementById('graphMetric').addEventListener('change',()=>this._redrawGraph());
  }
  _bindPills(gid,key){
    document.getElementById(gid).querySelectorAll('.pill').forEach(btn=>{
      btn.addEventListener('click',()=>{
        document.getElementById(gid).querySelectorAll('.pill').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');this.opts[key]=btn.dataset.value;
        if(this.simulation)this.simulation.updateOpts({[key]:this.opts[key]});
      });
    });
  }
  async _handleFile(file){
    const reader=new FileReader();
    reader.onload=async e=>{
      const dataUrl=e.target.result,base64=dataUrl.split(',')[1],mime=file.type;
      this._pendingBase64=base64; this._pendingMime=mime;
      // Store natural image dimensions for coordinate scaling
      const img=new Image();
      img.onload=()=>{ this._imgNaturalW=img.naturalWidth||800; this._imgNaturalH=img.naturalHeight||600; };
      img.src=dataUrl;
      document.getElementById('mapThumb').src=dataUrl;
      document.getElementById('uploadZone').style.display='none';
      document.getElementById('previewSection').style.display='';
      document.getElementById('markTool').style.display='';
      this._roads=[];this._pendingOuter=null;this._pendingInner=null;this._pendingWaypoints=[];this._motorwayLine=null;
      document.getElementById('slipTypePicker')?.remove();
      document.getElementById('markRoadList').innerHTML='';
      setTimeout(()=>{this._redrawOverlay();this._updateMarkBadge();},50);
      const hasKey=!!document.getElementById('apiKeyInput').value.trim();
      document.getElementById('hintText').textContent=hasKey
        ? 'Click road arms on the map to mark them, then Build — or just click Build for AI auto-detect.'
        : 'No API key — click each road arm on the map above, then click Build.';
    };
    reader.readAsDataURL(file);
  }

  _onMapClick(e){
    const img=document.getElementById('mapThumb');
    const imgRect=img.getBoundingClientRect();
    const x=e.clientX-imgRect.left, y=e.clientY-imgRect.top;
    if(x<0||y<0||x>imgRect.width||y>imgRect.height)return;
    const pt={
      x:x*(this._imgNaturalW/imgRect.width),
      y:y*(this._imgNaturalH/imgRect.height),
      dx:x, dy:y,
    };

    // ── Motorway M→M line ──────────────────────────────────
    if(this._markingMode==='motorway' && !this._motorwayLine){
      if(!this._pendingOuter){ this._pendingOuter=pt; }
      else{
        this._motorwayLine={p1:this._pendingOuter, p2:pt};
        this._pendingOuter=null;
      }
      this._redrawOverlay(); this._updateMarkBadge(); return;
    }

    // ── Intersection mode ──────────────────────────────────
    if(this._markingMode==='intersection'){
      if(!this._pendingOuter){ this._pendingOuter=pt; }
      else{
        this._roads.push({outer:this._pendingOuter, inner:pt, waypoints:[], type:'road'});
        this._pendingOuter=null;
        this._redrawOverlay(); this._updateMarkList(); this._updateMarkBadge();
      }
      this._redrawOverlay(); this._updateMarkBadge(); return;
    }

    // ── Motorway slip road multi-point ────────────────────
    // Phase A: no tip yet → first click = tip (A)
    if(!this._pendingOuter){
      this._pendingOuter=pt;           // tip
      this._pendingWaypoints=[];       // intermediate points
      this._showSlipWaypointUI();
    } else {
      // Each click adds a waypoint along the curve
      this._pendingWaypoints.push(pt);
    }
    this._redrawOverlay(); this._updateMarkBadge();
  }

  // Shows the inline UI while collecting waypoints for a slip road
  _showSlipWaypointUI(){
    document.getElementById('slipTypePicker')?.remove();
    const badge=document.getElementById('markModeBadge');
    const label=document.getElementById('markModeLabel');
    const n=this._roads.length;
    badge.textContent=String.fromCharCode(65+n);
    badge.style.background=this._markColour(n);
    label.textContent='Click points along the road. Last click = motorway join.';

    const row=document.createElement('div');
    row.id='slipTypePicker';
    row.style.cssText='display:flex;flex-direction:column;gap:6px;margin-top:6px';

    const info=document.createElement('p');
    info.style.cssText='font-size:10px;color:var(--text-dim);line-height:1.5;margin:0';
    info.innerHTML='Click <strong>along the slip road</strong> then click <strong>where it meets the motorway</strong> last. Then choose the type.';
    row.appendChild(info);

    const typeBtns=document.createElement('div');
    typeBtns.style.cssText='display:flex;gap:6px';
    ['off-ramp','on-ramp'].forEach(type=>{
      const btn=document.createElement('button');
      btn.className='pill'; btn.style.flex='1'; btn.style.fontSize='11px';
      btn.textContent=type==='off-ramp'?'↓ Done — Exit':'↑ Done — Entry';
      btn.onclick=()=>{
        const wpts=this._pendingWaypoints;
        if(wpts.length<1){
          info.textContent='⚠ Click at least 1 more point (the motorway join).'; return;
        }
        // Last waypoint = motorway join point (inner/1)
        const inner=wpts[wpts.length-1];
        const midWaypoints=wpts.slice(0,-1);
        this._roads.push({
          outer:this._pendingOuter,
          inner,
          waypoints:midWaypoints,
          type,
        });
        this._pendingOuter=null; this._pendingWaypoints=[];
        row.remove();
        this._redrawOverlay(); this._updateMarkList(); this._updateMarkBadge();
      };
      typeBtns.appendChild(btn);
    });
    row.appendChild(typeBtns);

    const cancelBtn=document.createElement('button');
    cancelBtn.className='btn-mark-clear';
    cancelBtn.style.cssText='font-size:10px;padding:4px';
    cancelBtn.textContent='✕ Cancel this slip road';
    cancelBtn.onclick=()=>{
      this._pendingOuter=null; this._pendingWaypoints=[];
      row.remove();
      this._redrawOverlay(); this._updateMarkBadge();
    };
    row.appendChild(cancelBtn);

    const badge_row=document.getElementById('markModeBadge').parentElement;
    badge_row.parentElement.insertBefore(row, badge_row.nextSibling);
  }

  _redrawOverlay(){
    const img=document.getElementById('mapThumb');
    const oc=document.getElementById('overlayCanvas');
    oc.width=img.clientWidth||250; oc.height=img.clientHeight||160;
    const ctx=oc.getContext('2d');
    ctx.clearRect(0,0,oc.width,oc.height);
    const sx=oc.width/(img.clientWidth||oc.width), sy=oc.height/(img.clientHeight||oc.height);

    // Draw M→M motorway line in blue
    if(this._motorwayLine){
      const mx1=this._motorwayLine.p1.dx*sx, my1=this._motorwayLine.p1.dy*sy;
      const mx2=this._motorwayLine.p2.dx*sx, my2=this._motorwayLine.p2.dy*sy;
      ctx.strokeStyle='#1d4ed8'; ctx.lineWidth=3; ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(mx1,my1);ctx.lineTo(mx2,my2);ctx.stroke();
      // M dots at each end
      [[mx1,my1],[mx2,my2]].forEach(([x,y])=>{
        ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);
        ctx.fillStyle='#1d4ed8cc';ctx.fill();
        ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();
        ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';
        ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('M',x,y);
      });
    } else if(this._pendingOuter && this._markingMode==='motorway' && !this._motorwayLine){
      // Pending first M click
      const ox=this._pendingOuter.dx*sx, oy=this._pendingOuter.dy*sy;
      ctx.beginPath();ctx.arc(ox,oy,8,0,Math.PI*2);
      ctx.fillStyle='#1d4ed8aa';ctx.fill();
      ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();
      ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';
      ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('M',ox,oy);
    }

    // Draw completed slip road pairs
    this._roads.forEach((road,i)=>{
      const col=this._markColour(i);
      const allPts=[road.outer, ...(road.waypoints||[]), road.inner];
      // Draw polyline through all points
      ctx.strokeStyle=col; ctx.lineWidth=2; ctx.setLineDash([]);
      ctx.beginPath();
      allPts.forEach((p,j)=>{
        const px=p.dx*sx, py=p.dy*sy;
        j===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
      });
      ctx.stroke();
      // Outer dot (letter A/B/C)
      const op=road.outer;
      ctx.beginPath();ctx.arc(op.dx*sx,op.dy*sy,8,0,Math.PI*2);ctx.fillStyle=col+'bb';ctx.fill();
      ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();
      ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(String.fromCharCode(65+i),op.dx*sx,op.dy*sy);
      // Waypoint dots (small)
      (road.waypoints||[]).forEach(p=>{
        ctx.beginPath();ctx.arc(p.dx*sx,p.dy*sy,4,0,Math.PI*2);
        ctx.fillStyle=col+'99';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.stroke();
      });
      // Inner dot (number, square)
      const ip=road.inner;
      ctx.fillStyle=col+'bb';ctx.strokeStyle='#fff';ctx.lineWidth=1.5;
      ctx.beginPath();ctx.roundRect(ip.dx*sx-6,ip.dy*sy-6,12,12,2);ctx.fill();ctx.stroke();
      ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(String(i+1),ip.dx*sx,ip.dy*sy);
    });

    // In-progress slip road (tip placed, waypoints being collected)
    if(this._pendingOuter && this._markingMode==='motorway' && this._motorwayLine){
      const n=this._roads.length;
      const col=this._markColour(n);
      const allPts=[this._pendingOuter, ...(this._pendingWaypoints||[])];
      // Draw line through all points so far
      ctx.strokeStyle=col; ctx.lineWidth=2; ctx.setLineDash([4,3]);
      ctx.beginPath();
      allPts.forEach((p,i)=>{
        const px=p.dx*sx, py=p.dy*sy;
        i===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
      });
      ctx.stroke(); ctx.setLineDash([]);
      // Draw each point
      allPts.forEach((p,i)=>{
        const px=p.dx*sx, py=p.dy*sy;
        ctx.beginPath();ctx.arc(px,py,i===0?8:5,0,Math.PI*2);
        ctx.fillStyle=i===0?col+'cc':'#fff';ctx.fill();
        ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.stroke();
        if(i===0){
          ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';
          ctx.textAlign='center';ctx.textBaseline='middle';
          ctx.fillText(String.fromCharCode(65+n),px,py);
        }
      });
      // Pulsing ring on last point
      const last=allPts[allPts.length-1];
      ctx.beginPath();ctx.arc(last.dx*sx,last.dy*sy,10,0,Math.PI*2);
      ctx.strokeStyle=col+'88';ctx.lineWidth=1.5;ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);
    } else if(this._pendingOuter && !(this._markingMode==='motorway' && !this._motorwayLine)){
      const n=this._roads.length;
      const col=this._markColour(n);
      const ox=this._pendingOuter.dx*sx, oy=this._pendingOuter.dy*sy;
      ctx.beginPath();ctx.arc(ox,oy,8,0,Math.PI*2);
      ctx.fillStyle=col+'99';ctx.fill();
      ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();
      ctx.fillStyle='#fff';ctx.font='bold 9px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(String.fromCharCode(65+n),ox,oy);
      ctx.beginPath();ctx.arc(ox,oy,12,0,Math.PI*2);
      ctx.strokeStyle=col+'66';ctx.lineWidth=1.5;ctx.setLineDash([4,3]);ctx.stroke();ctx.setLineDash([]);
    }
  }

  _updateMarkList(){
    const list=document.getElementById('markRoadList');
    list.innerHTML='';
    // Show M→M motorway line if set
    if(this._motorwayLine){
      const item=document.createElement('div');item.className='mark-road-item';
      const dot=document.createElement('span');dot.className='mark-road-dot';dot.style.background='#1d4ed8';
      const lbl=document.createElement('span');lbl.textContent='Motorway M→M';lbl.style.fontWeight='600';
      const rm=document.createElement('button');rm.className='mark-road-remove';rm.textContent='×';
      rm.onclick=()=>{this._motorwayLine=null;this._redrawOverlay();this._updateMarkList();this._updateMarkBadge();};
      item.appendChild(dot);item.appendChild(lbl);item.appendChild(rm);list.appendChild(item);
    }
    this._roads.forEach((road,i)=>{
      const item=document.createElement('div');item.className='mark-road-item';
      const dot=document.createElement('span');dot.className='mark-road-dot';dot.style.background=this._markColour(i);
      const lbl=document.createElement('span');
      const typeLabel=road.type==='on-ramp'?'↑ on-ramp':road.type==='off-ramp'?'↓ off-ramp':'road';
      lbl.textContent=`${String.fromCharCode(65+i)}→${i+1}  ${typeLabel}`;
      const rm=document.createElement('button');rm.className='mark-road-remove';rm.textContent='×';
      rm.onclick=()=>{
        this._roads.splice(i,1);this._pendingOuter=null;
        this._redrawOverlay();this._updateMarkList();this._updateMarkBadge();
      };
      item.appendChild(dot);item.appendChild(lbl);item.appendChild(rm);list.appendChild(item);
    });
    if(this._pendingOuter){
      const n=this._roads.length;
      const item=document.createElement('div');item.className='mark-road-item';
      const dot=document.createElement('span');dot.className='mark-road-dot';dot.style.background=this._markColour(n);
      const lbl=document.createElement('span');lbl.textContent=`Road ${String.fromCharCode(65+n)} — click junction end`;lbl.style.fontStyle='italic';
      item.appendChild(dot);item.appendChild(lbl);list.appendChild(item);
    }
  }

  async _buildFromMarks(){
    const stage=document.getElementById('simStage');
    const W=stage.clientWidth||800, H=stage.clientHeight||600;
    const hasKey=!!document.getElementById('apiKeyInput').value.trim();
    const minRoads=this._markingMode==='motorway'?1:2;
    const hasRoads=this._roads.length>=minRoads;
    if(hasRoads){
      this.network=this._buildFromMarkedPoints(W,H);
      this._finishSetup(W,H);
    }else if(hasKey){
      await this._runAIAnalysis(W,H);
    }else{
      document.getElementById('hintText').textContent=
        this._markingMode==='motorway'
          ? '⚠ Mark at least 1 slip road, or add an API key for AI detection.'
          : '⚠ Mark at least 2 road arms (outer + junction end each), or add an API key.';
    }
  }

  async _runAIAnalysis(W,H){
    this._showOverlay('Sending to Claude AI…',10);
    const prog=setInterval(()=>{
      const cur=parseInt(document.getElementById('progressFill').style.width)||0;
      if(cur<82)this._updateOverlay(null,cur+2);
    },180);
    try{
      const resized=await ImageAnalyser._resizeImage(this._pendingBase64,this._pendingMime);
      this.network=await ImageAnalyser.analyse(resized.base64,resized.mimeType,W,H,
        document.getElementById('apiKeyInput').value.trim());
      clearInterval(prog);
      this._updateOverlay(this.network.mode==='motorway'?'Motorway junction detected':'Intersection detected',96);
      await new Promise(r=>setTimeout(r,500));
      this._hideOverlay();
      this._finishSetup(W,H);
    }catch(err){
      clearInterval(prog);this._hideOverlay();
      console.error('AI analysis error:',err);
      const msg=err.message||String(err);
      document.getElementById('hintText').textContent='⚠ '+msg;
    }
  }

  _finishSetup(W,H){
    document.getElementById('markTool').style.display='none';
    document.getElementById('signalBtns').closest('.control-group').style.display=
      this.network.mode==='motorway'?'none':'';
    this._setupCanvas(W,H);this._showControls();this._showFeatures();
    document.getElementById('hintText').textContent='';
  }

  _showOverlay(msg,pct){document.getElementById('analysisOverlay').style.display='flex';this._updateOverlay(msg,pct);}
  _updateOverlay(msg,pct){if(msg!==null)document.getElementById('overlayStatus').textContent=msg;if(pct!==null)document.getElementById('progressFill').style.width=pct+'%';}
  _hideOverlay(){document.getElementById('analysisOverlay').style.display='none';}
  _setupCanvas(W,H){
    const c=document.getElementById('simCanvas');c.width=W;c.height=H;c.style.display='';
    document.getElementById('stagePlaceholder').style.display='none';
    this.renderer=new Renderer(c,this.network);
    this.graphRdr=new GraphRenderer(document.getElementById('graphCanvas'));
    this.renderer.clear();this.renderer.drawRoads(null);
  }
  _showControls(){
    document.getElementById('controlsSection').style.display='';
    document.getElementById('previewSection').style.display='';
    document.getElementById('btnExport').style.display='';
  }
  _showFeatures(){
    if(!this.network)return;
    const list=document.getElementById('featureList');list.innerHTML='';
    const m=this.network.mode;
    const items=m==='motorway'?[
      'Mode: Motorway Junction',`Type: ${this.network.junctionType}`,
      `Main roads: ${this.network.mainRoads.length}`,`Slip roads: ${this.network.slipRoads.length}`,
      `Speed: ~${this.network.speedLimit} km/h`,...this.network.features.slice(0,3),
    ]:[
      'Mode: Intersection',`Type: ${this.network.intersectionType}`,
      `Roads: ${this.network.roads.length}`,`Signals: ${this.network.roads.filter(r=>r.hasSignal).length}`,
      `Speed: ~${this.network.speedLimit} km/h`,...this.network.features.slice(0,3),
    ];
    const icons=['🛣','⬡','🚗','↪','⚡','●','●','●'];
    items.forEach((f,i)=>{const li=document.createElement('li');li.dataset.icon=icons[i]||'●';li.textContent=f;list.appendChild(li);});
    document.getElementById('analysisSection').style.display='';
  }
  _startSim(){
    if(!this.network)return;this._stopSim();
    this.simulation=new Simulation(this.network,{...this.opts});this.simTime=0;
    document.getElementById('btnRun').style.display='none';
    document.getElementById('btnPause').style.display='';document.getElementById('btnPause').textContent='⏸  Pause';
    document.getElementById('hud').style.display='flex';
    let last=performance.now();
    const loop=now=>{
      const dt=Math.min((now-last)/1000,0.05);last=now;
      this.simulation.step(dt);this.simTime+=dt;
      this.renderer.clear();this.renderer.drawRoads(this.simulation.signal);
      this.renderer.drawHeatmap(this.simulation.vehicles);this.renderer.drawVehicles(this.simulation.vehicles);
      this._updateMetrics();this._redrawGraph();
      this.animId=requestAnimationFrame(loop);
    };
    this.animId=requestAnimationFrame(loop);
  }
  _stopSim(){if(this.animId)cancelAnimationFrame(this.animId);this.animId=null;}
  _togglePause(){
    if(this.animId){this._stopSim();document.getElementById('btnPause').textContent='▶  Resume';}
    else{this._startSim();document.getElementById('btnPause').textContent='⏸  Pause';}
  }
  _updateMetrics(){
    if(!this.simulation)return;const s=this.simulation.getSnapshot();
    this._setM('metThroughput',s.throughput,'barThroughput',s.throughput/100);
    this._setM('metWait',s.avgWait.toFixed(1),'barWait',Math.min(1,s.avgWait/60));
    this._setM('metQueue',s.queue,'barQueue',Math.min(1,s.queue/30));
    this._setM('metRisk',(s.risk*100).toFixed(0)+'%','barRisk',s.risk);
    const veh=this.simulation.vehicles;
    document.getElementById('hudFlow').textContent=veh.filter(v=>v.state==='MOVING').length;
    document.getElementById('hudSlow').textContent=veh.filter(v=>v.state==='SLOWING').length;
    document.getElementById('hudStop').textContent=veh.filter(v=>v.state==='STOPPED'||v.state==='WAITING').length;
    const s2=Math.floor(this.simTime);
    document.getElementById('hudSimTime').textContent=String(Math.floor(s2/60)).padStart(2,'0')+':'+String(s2%60).padStart(2,'0');
  }
  _setM(vid,val,bid,frac){document.getElementById(vid).textContent=val;document.getElementById(bid).style.width=Math.min(100,frac*100)+'%';}
  _redrawGraph(){if(!this.simulation||!this.graphRdr)return;this.graphRdr.draw(this.simulation.metrics.history,document.getElementById('graphMetric').value);}
  _exportCSV(){
    if(!this.simulation)return;
    const blob=new Blob([this.simulation.metrics.exportCSV()],{type:'text/csv'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='traffic_metrics.csv';a.click();
  }
}

document.addEventListener('DOMContentLoaded',()=>new AppController());
