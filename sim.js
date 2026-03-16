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
  motorwayMain: 4.2,   // ~100 km/h base (fast lane)
  motorwayMid:  3.8,   // ~90 km/h middle lane
  motorwaySlow: 3.4,   // ~80 km/h slow lane (lane 0, rightmost)
  motorwaySlip: 2.1,   // ~70 km/h slip roads / ramps
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
    const LANES=3,laneSpd=l=>l===0?SPEED.motorwaySlow:l===1?SPEED.motorwayMid:SPEED.motorwayMain;
    const laneOff=(road,lane)=>{const perp=road.angleRad+Math.PI/2,d=(lane-(LANES-1)/2)*LANE_W;return{ox:Math.cos(perp)*d,oy:Math.sin(perp)*d};};
    if(routeType==='through'){
      const road=net.mainRoads[Math.floor(Math.random()*net.mainRoads.length)];
      const pts=road.polyline||[{x:road.x1,y:road.y1},{x:road.x2,y:road.y2}];
      const lane=Math.floor(Math.random()*LANES),spd=laneSpd(lane)*(0.9+Math.random()*0.2);
      const {ox,oy}=laneOff(road,lane);
      this.x=pts[0].x+ox;this.y=pts[0].y+oy;this.speed=spd;this.laneIdx=lane;
      this.routeDir=road.id;this.roadId=road.id;this.isOnSlip=false;
      this.angle=pts.length>1?Math.atan2(pts[1].y-pts[0].y,pts[1].x-pts[0].x):0;
      this.path=pts.slice(1).map((p,i,a)=>({x:p.x+ox,y:p.y+oy,action:i===a.length-1?'DONE':'MOVING',speed:spd}));
    }else if(routeType==='exit'){
      const slip=net.slipRoads.find(s=>s.id===slipId)||net.slipRoads[0];
      if(!slip){this._initMotorway({routeType:'through',mainRoadId:0,slipId:0});return;}
      const road=net.mainRoads.find(r=>r.id===slip.fromRoadId)||net.mainRoads[0];
      const pts=road.polyline||[{x:road.x1,y:road.y1},{x:road.x2,y:road.y2}];
      const {ox,oy}=laneOff(road,0);
      const spawn=Math.hypot(pts[0].x-slip.bx,pts[0].y-slip.by)>Math.hypot(pts[pts.length-1].x-slip.bx,pts[pts.length-1].y-slip.by)?pts[0]:pts[pts.length-1];
      this.x=spawn.x+ox;this.y=spawn.y+oy;this.speed=SPEED.motorwayMain;
      this.routeDir=road.id;this.roadId=road.id;this.isOnSlip=false;
      const curve=slip.curve||[];
      this.path=[{x:slip.bx,y:slip.by,action:'DECEL',speed:SPEED.motorwayMain},...curve.map(p=>({x:p.x,y:p.y,action:'MOVING',speed:SPEED.motorwaySlip})),{x:slip.tx,y:slip.ty,action:'DONE',speed:SPEED.motorwaySlip}];
    }else{
      const slip=net.slipRoads.find(s=>s.id===slipId)||net.slipRoads[0];
      if(!slip){this._initMotorway({routeType:'through',mainRoadId:0,slipId:0});return;}
      const road=net.mainRoads.find(r=>r.id===slip.toRoadId)||net.mainRoads[0];
      const pts=road.polyline||[{x:road.x1,y:road.y1},{x:road.x2,y:road.y2}];
      const {ox,oy}=laneOff(road,0);
      const exit=Math.hypot(pts[0].x-slip.bx,pts[0].y-slip.by)>Math.hypot(pts[pts.length-1].x-slip.bx,pts[pts.length-1].y-slip.by)?pts[0]:pts[pts.length-1];
      this.x=slip.tx;this.y=slip.ty;
      this.mergeDelay=slip.hasMergeConflict?this.rules.conflictFactor*(1+Math.random()*2):0;
      this.speed=SPEED.motorwaySlip;this.routeDir=road.id;this.roadId=road.id;this.isOnSlip=true;
      const curve=slip.curve||[];
      this.path=[...[...curve].reverse().map(p=>({x:p.x,y:p.y,action:'MOVING',speed:SPEED.motorwaySlip})),{x:slip.bx,y:slip.by,action:'MERGE',speed:SPEED.motorwaySlip},{x:exit.x+ox,y:exit.y+oy,action:'DONE',speed:SPEED.motorwayMain}];
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
    const cW=3*LANE_W;
    const drawPoly=(pts,lw,style)=>{
      if(!pts||pts.length<2)return;
      ctx.strokeStyle=style;ctx.lineWidth=lw;ctx.lineJoin='round';ctx.lineCap='round';ctx.setLineDash([]);
      ctx.beginPath();pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));ctx.stroke();
    };
    const snap=(pt,poly)=>{
      let best=pt,bestD=Infinity;
      for(let i=1;i<poly.length;i++){
        const a=poly[i-1],b=poly[i],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;
        const t=l2?Math.max(0,Math.min(1,((pt.x-a.x)*dx+(pt.y-a.y)*dy)/l2)):0;
        const d=Math.hypot(pt.x-(a.x+t*dx),pt.y-(a.y+t*dy));
        if(d<bestD){bestD=d;best={x:a.x+t*dx,y:a.y+t*dy};}
      }
      return best;
    };
    // Verge
    net.mainRoads.forEach(r=>drawPoly(r.polyline||[{x:r.x1,y:r.y1},{x:r.x2,y:r.y2}],cW+26,'#c8d8b8'));
    // Road surface + markings
    net.mainRoads.forEach(road=>{
      const pts=road.polyline||[{x:road.x1,y:road.y1},{x:road.x2,y:road.y2}];
      drawPoly(pts,cW,'#7a8599');
      drawPoly(pts,2,'rgba(255,255,255,0.9)');
      ctx.setLineDash([18,12]);drawPoly(pts,1,'rgba(255,255,255,0.4)');ctx.setLineDash([]);
      ctx.fillStyle='rgba(255,255,255,0.3)';
      let dist=0;
      for(let i=1;i<pts.length;i++){
        const dx=pts[i].x-pts[i-1].x,dy=pts[i].y-pts[i-1].y;dist+=Math.hypot(dx,dy);
        if(dist>120){dist=0;ctx.save();ctx.translate((pts[i].x+pts[i-1].x)/2,(pts[i].y+pts[i-1].y)/2);ctx.rotate(Math.atan2(dy,dx));ctx.beginPath();ctx.moveTo(8,0);ctx.lineTo(-4,-4);ctx.lineTo(-4,4);ctx.closePath();ctx.fill();ctx.restore();}
      }
    });
    // Slip roads — snapped, arrows only
    net.slipRoads.forEach(slip=>{
      let pts=slip.renderPts?[...slip.renderPts]:[{x:slip.bx,y:slip.by},{x:slip.tx,y:slip.ty}];
      if(pts.length<2)return;
      const road=net.mainRoads.find(r=>r.id===slip.fromRoadId)||net.mainRoads.find(r=>r.id===slip.toRoadId)||net.mainRoads[0];
      if(road?.polyline?.length>1){
        const isOff=slip.type==='off-ramp'||slip.type==='diverge';
        if(isOff) pts[0]=snap(pts[0],road.polyline);
        else pts[pts.length-1]=snap(pts[pts.length-1],road.polyline);
      }
      const slipW=LANE_W+4;
      drawPoly(pts,slipW+10,'#b8c8a8');
      drawPoly(pts,slipW,'#9aa0ad');
      drawPoly(pts,1,'rgba(255,255,255,0.5)');
      const mi=Math.floor((pts.length-1)*0.5);
      const p0=pts[Math.min(mi,pts.length-2)],p1=pts[Math.min(mi+1,pts.length-1)];
      const isOn=slip.type==='on-ramp'||slip.type==='merge';
      ctx.save();ctx.translate((p0.x+p1.x)/2,(p0.y+p1.y)/2);
      ctx.rotate(isOn?Math.atan2(p0.y-p1.y,p0.x-p1.x):Math.atan2(p1.y-p0.y,p1.x-p0.x));
      ctx.fillStyle=isOn?'#16a34a':'#d97706';
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
//  OSM FETCHER
// ════════════════════════════════════════════════════════════════

class OSMFetcher {
  static async geocode(query) {
    const m=query.trim().match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
    if(m) return {lat:parseFloat(m[1]),lon:parseFloat(m[2]),name:query};
    const r=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      {headers:{'Accept-Language':'en','User-Agent':'IntersectSim/1.0'}});
    const d=await r.json();
    if(!d.length) throw new Error(`Location not found: "${query}"`);
    return {lat:parseFloat(d[0].lat),lon:parseFloat(d[0].lon),name:d[0].display_name};
  }

  static async fetchRoads(lat,lon,radius=500) {
    const q=`[out:json][timeout:20];way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|secondary)$"](around:${radius},${lat},${lon});out body;>;out skel qt;`;
    const servers=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
    let lastErr;
    for(const server of servers){
      try{
        const r=await fetch(server,{method:'POST',body:'data='+encodeURIComponent(q),signal:AbortSignal.timeout(18000)});
        if(!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      }catch(e){lastErr=e;console.warn(`Overpass ${server} failed:`,e.message);}
    }
    throw new Error('Overpass API unavailable — try again in a moment. ('+lastErr?.message+')');
  }

  // BFS to split a set of ways into connected components (by shared nodes)
  static _components(ways) {
    const wayMap={};
    ways.forEach(w=>{wayMap[w.id]=w;});
    const nodeWays={};
    ways.forEach(w=>w.nodes.forEach(n=>{(nodeWays[n]=nodeWays[n]||[]).push(w.id);}));
    // Build adjacency
    const adj={};
    ways.forEach(w=>{adj[w.id]=new Set();});
    Object.values(nodeWays).forEach(wids=>{
      for(let i=0;i<wids.length;i++) for(let j=i+1;j<wids.length;j++){
        adj[wids[i]].add(wids[j]); adj[wids[j]].add(wids[i]);
      }
    });
    const visited=new Set(), components=[];
    ways.forEach(w=>{
      if(visited.has(w.id)) return;
      const comp=[], queue=[w.id];
      while(queue.length){
        const id=queue.pop();
        if(visited.has(id)) continue;
        visited.add(id); comp.push(wayMap[id]);
        adj[id].forEach(nb=>{if(!visited.has(nb))queue.push(nb);});
      }
      components.push(comp);
    });
    return components;
  }

  // Stitch ways in a component into one ordered polyline
  static _stitch(ways) {
    if(!ways.length) return [];
    const byStart={},byEnd={};
    ways.forEach(w=>{byStart[w.nodes[0]]=w;byEnd[w.nodes[w.nodes.length-1]]=w;});
    let head=ways.find(w=>!byEnd[w.nodes[0]])||ways[0];
    const ids=[],seen=new Set();
    let cur=head;
    while(cur&&!seen.has(cur.id)){
      seen.add(cur.id);
      ids.push(...(ids.length?cur.nodes.slice(1):cur.nodes));
      cur=byStart[cur.nodes[cur.nodes.length-1]];
    }
    // Add any missed ways (disconnected within component)
    ways.filter(w=>!seen.has(w.id)).forEach(w=>ids.push(...w.nodes.slice(1)));
    return ids;
  }

  static buildNetwork(osmData,lat,lon,W,H) {
    const elements=osmData.elements||[];
    const nodeMap={};
    elements.filter(e=>e.type==='node').forEach(n=>{nodeMap[n.id]=n;});
    const ways=elements.filter(e=>e.type==='way'&&e.nodes&&e.tags);
    const scale=Math.min(W,H)/2/500;
    const project=(nLat,nLon)=>({
      x:W/2+(nLon-lon)*111320*Math.cos(lat*Math.PI/180)*scale,
      y:H/2-(nLat-lat)*111320*scale,
    });
    const nodePt=nid=>{const n=nodeMap[nid];return n?project(n.lat,n.lon):null;};
    const mwWays=ways.filter(w=>w.tags.highway==='motorway'||w.tags.highway==='trunk');
    const lkWays=ways.filter(w=>w.tags.highway==='motorway_link'||w.tags.highway==='trunk_link');
    if(mwWays.length>0||lkWays.length>0)
      return OSMFetcher._buildMotorway(mwWays,lkWays,nodeMap,nodePt,W,H);
    return OSMFetcher._buildIntersection(ways,nodeMap,project,lat,lon,W,H);
  }

  static _buildMotorway(mwWays,lkWays,nodeMap,nodePt,W,H) {
    // Group by ref, pick the dominant road (most ways)
    const byRef={};
    mwWays.forEach(w=>{const ref=w.tags.ref||w.tags.name||'_';(byRef[ref]=byRef[ref]||[]).push(w);});
    const dominantWays=Object.values(byRef).sort((a,b)=>b.length-a.length)[0]||mwWays;

    // BFS split into connected components = carriageways
    const components=OSMFetcher._components(dominantWays);
    components.sort((a,b)=>b.length-a.length); // longest first
    const topTwo=components.slice(0,2);

    const toPolyline=ids=>ids.map(nid=>nodePt(nid)).filter(p=>p&&!isNaN(p.x));

    const mainRoads=topTwo.map((comp,i)=>{
      const ids=OSMFetcher._stitch(comp);
      const pts=toPolyline(ids);
      if(!pts.length) return null;
      return {
        id:i, name:`Carriageway ${String.fromCharCode(65+i)}`,
        x1:pts[0].x,y1:pts[0].y,x2:pts[pts.length-1].x,y2:pts[pts.length-1].y,
        angleRad:Math.atan2(pts[pts.length-1].y-pts[0].y,pts[pts.length-1].x-pts[0].x),
        lanes:3,lanesEachWay:3,speedLimit:120,roadType:'motorway',
        polyline:pts,
      };
    }).filter(Boolean);

    if(!mainRoads.length) mainRoads.push({id:0,name:'Motorway',x1:0,y1:H/2,x2:W,y2:H/2,angleRad:0,lanes:3,lanesEachWay:3,speedLimit:120,roadType:'motorway',polyline:[{x:0,y:H/2},{x:W,y:H/2}]});

    // Snap point to nearest position on a polyline
    const snap=(pt,poly)=>{
      let best=pt,bestD=Infinity;
      for(let i=1;i<poly.length;i++){
        const a=poly[i-1],b=poly[i],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;
        const t=l2?Math.max(0,Math.min(1,((pt.x-a.x)*dx+(pt.y-a.y)*dy)/l2)):0;
        const d=Math.hypot(pt.x-(a.x+t*dx),pt.y-(a.y+t*dy));
        if(d<bestD){bestD=d;best={x:a.x+t*dx,y:a.y+t*dy};}
      }
      return best;
    };

    const slipRoads=lkWays.map((way,i)=>{
      const pts=way.nodes.map(nid=>nodePt(nid)).filter(p=>p&&!isNaN(p.x));
      if(pts.length<2) return null;
      const s=pts[0],e=pts[pts.length-1];
      const near=pt=>mainRoads.reduce((mn,r)=>Math.min(mn,r.polyline.reduce((m,p)=>Math.min(m,Math.hypot(p.x-pt.x,p.y-pt.y)),Infinity)),Infinity);
      const type=near(s)<near(e)?'off-ramp':'on-ramp';
      const jPt=type==='off-ramp'?s:e, tPt=type==='off-ramp'?e:s;
      let bestRoad=mainRoads[0],bestD=Infinity;
      mainRoads.forEach(r=>{
        const d=r.polyline.reduce((mn,p)=>Math.min(mn,Math.hypot(p.x-jPt.x,p.y-jPt.y)),Infinity);
        if(d<bestD){bestD=d;bestRoad=r;}
      });
      const bPt=snap(jPt,bestRoad.polyline);
      const renderPts=type==='off-ramp'?[bPt,...pts.slice(1,-1),tPt]:[tPt,...pts.slice(1,-1),bPt];
      const curve=type==='off-ramp'?pts.slice(1,-1):pts.slice(1,-1).reverse();
      return{id:i,type,fromRoadId:bestRoad.id,toRoadId:bestRoad.id,hasMergeConflict:type==='on-ramp',
        bx:bPt.x,by:bPt.y,tx:tPt.x,ty:tPt.y,slipLen:Math.hypot(tPt.x-bPt.x,tPt.y-bPt.y),curve,renderPts};
    }).filter(Boolean);

    return{mode:'motorway',junctionType:'interchange',mainRoads,slipRoads,cx:W/2,cy:H/2,
      speedLimit:120,features:['OpenStreetMap data',`${dominantWays.length} ways → ${mainRoads.length} carriageways`,`${lkWays.length} slip roads`],confidence:1.0};
  }

  static _buildIntersection(ways,nodeMap,project,lat,lon,W,H) {
    const cx=W/2,cy=H/2;
    const nodeCounts={};
    ways.forEach(w=>w.nodes.forEach(nid=>{nodeCounts[nid]=(nodeCounts[nid]||0)+1;}));
    const junctionNodes=Object.entries(nodeCounts).filter(([,c])=>c>=2).map(([nid])=>nodeMap[nid]).filter(Boolean);
    let jNode=null,bestDist=Infinity;
    junctionNodes.forEach(n=>{const p=project(n.lat,n.lon),d=Math.hypot(p.x-cx,p.y-cy);if(d<bestDist){bestDist=d;jNode=n;}});
    const jPt=jNode?project(jNode.lat,jNode.lon):{x:cx,y:cy};
    const roads=[];
    ways.forEach((way,i)=>{
      if(!jNode)return;
      const idx=way.nodes.indexOf(jNode.id);if(idx===-1)return;
      const farIdx=idx===0?way.nodes.length-1:0;
      const farNode=nodeMap[way.nodes[farIdx]];if(!farNode)return;
      const farPt=project(farNode.lat,farNode.lon);
      const rad=Math.atan2(-(farPt.y-jPt.y),farPt.x-jPt.x);
      const lanes=parseInt(way.tags.lanes)||2;
      roads.push({id:i,angleDeg:Math.round(((rad*180/Math.PI)+360)%360),angleRad:rad,
        lanesIn:Math.ceil(lanes/2),lanesOut:Math.floor(lanes/2),hasSignal:ways.length<=4,
        hasCrosswalk:!!way.tags.crossing,roadType:['motorway','trunk','primary'].includes(way.tags.highway)?'major':'minor',
        ex:farPt.x,ey:farPt.y,ix:jPt.x,iy:jPt.y,speedLimit:parseInt(way.tags.maxspeed)||50});
    });
    const type=roads.length===3?'T-junction':roads.length===4?'4-way':roads.length>=5?'complex':'T-junction';
    return{mode:'intersection',intersectionType:type,roads:roads.slice(0,6),cx:jPt.x,cy:jPt.y,
      reach:Math.min(W,H)*0.42,hasCentralIsland:false,speedLimit:50,
      features:['OpenStreetMap data',`${ways.length} roads`,type],confidence:1.0};
  }
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
    this._motorwayLine = null;   // legacy, kept for compat
    this._motorwayA = null;      // carriageway A: {p1,p2} M1→M2
    this._motorwayB = null;      // carriageway B: {p1,p2} M3→M4
    this._pendingM1 = null;
    this._pendingM3 = null;
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
      if(!this._motorwayA){
        instr.innerHTML='<strong>Step 1:</strong> Click <strong>M1</strong> then <strong>M2</strong> — the two ends of the <strong>first carriageway</strong> (click in the direction traffic flows).';
        badge.textContent='M1'; badge.style.background='#1d4ed8';
        label.textContent=this._pendingM1?'Now click M2 (other end, same carriageway)':'Click M1 — one end of carriageway 1';
      }else if(!this._motorwayB){
        instr.innerHTML='<strong>Step 2:</strong> Click <strong>M3</strong> then <strong>M4</strong> — the two ends of the <strong>second carriageway</strong> (opposite direction).';
        badge.textContent='M3'; badge.style.background='#0f766e';
        label.textContent=this._pendingM3?'Now click M4 (other end, carriageway 2)':'Click M3 — one end of carriageway 2';
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
      if(!this._motorwayA || !this._motorwayB) return null;

      const makeRoad=(line, id, sx, sy)=>{
        const x1=line.p1.x*sx, y1=line.p1.y*sy;
        const x2=line.p2.x*sx, y2=line.p2.y*sy;
        const angleRad=Math.atan2(y2-y1, x2-x1); // raw screen angle, x1→x2 direction
        return { id, name: id===0?'Carriageway A':'Carriageway B',
          x1, y1, x2, y2, angleRad, speedLimit:120, roadType:'motorway' };
      };

      const mainRoads=[
        makeRoad(this._motorwayA, 0, sx, sy),
        makeRoad(this._motorwayB, 1, sx, sy),
      ];
      // cx/cy = midpoint between the two carriageways' midpoints
      const mid=(r)=>({ x:(r.x1+r.x2)/2, y:(r.y1+r.y2)/2 });
      const mA=mid(mainRoads[0]), mB=mid(mainRoads[1]);
      const cx2=(mA.x+mB.x)/2, cy2=(mA.y+mB.y)/2;

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
        // Assign to whichever carriageway's line the branch point is closest to
        const distToRoad=(r,px,py)=>{
          const dx=r.x2-r.x1, dy=r.y2-r.y1, len2=dx*dx+dy*dy;
          if(len2===0) return Math.hypot(px-r.x1,py-r.y1);
          const t=Math.max(0,Math.min(1,((px-r.x1)*dx+(py-r.y1)*dy)/len2));
          return Math.hypot(px-(r.x1+t*dx), py-(r.y1+t*dy));
        };
        const roadId = distToRoad(mainRoads[0],bx,by) <= distToRoad(mainRoads[1],bx,by) ? 0 : 1;
        return {
          id:i, type,
          fromRoadId:roadId, toRoadId:roadId,
          hasMergeConflict:type==='on-ramp',
          bx, by, tx, ty, slipLen,
          curve,
          renderPts:[{x:ox,y:oy},...waypoints,{x:ix,y:iy}],
        };
      });

      return{mode:'motorway',junctionType:'interchange',mainRoads,slipRoads,
        cx:cx2,cy:cy2,speedLimit:120,features:['Manually marked motorway junction'],confidence:1.0};

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
    zone.addEventListener('click',(e)=>{
      if(e.target.closest('#osmSearch')||e.target.closest('#btnOsmSearch'))return;
      input.click();
    });
    const osmBtn=document.getElementById('btnOsmSearch'),osmInput=document.getElementById('osmSearch');
    if(osmBtn&&osmInput){
      const go=()=>{const q=osmInput.value.trim();if(q)this._fetchOSM(q);};
      osmBtn.addEventListener('click',(e)=>{e.stopPropagation();go();});
      osmInput.addEventListener('keydown',(e)=>{e.stopPropagation();if(e.key==='Enter')go();});
    }
    zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});
    zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
    zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');if(e.dataTransfer.files[0]?.type.startsWith('image/'))this._handleFile(e.dataTransfer.files[0]);});
    input.addEventListener('change',()=>{if(input.files[0])this._handleFile(input.files[0]);});
    document.getElementById('btnReupload').addEventListener('click',()=>{
      ['previewSection','markTool','controlsSection','analysisSection'].forEach(id=>{document.getElementById(id).style.display='none';});
      document.getElementById('uploadZone').style.display='';
      document.getElementById('btnExport').style.display='none';
      this._roads=[];this._pendingOuter=null;this._pendingWaypoints=[];this._motorwayLine=null;this._motorwayA=null;this._motorwayB=null;this._pendingM1=null;this._pendingM3=null;
      this._stopSim();
    });

    // Road marking tool
    document.getElementById('mapPreviewWrap').addEventListener('click', e => this._onMapClick(e));
    document.getElementById('btnBuild').addEventListener('click', () => this._buildFromMarks());
    document.getElementById('btnMarkClear').addEventListener('click', () => {
      this._roads=[];this._pendingOuter=null;this._pendingInner=null;this._pendingWaypoints=[];this._motorwayLine=null;this._motorwayA=null;this._motorwayB=null;this._pendingM1=null;this._pendingM3=null;
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
      this._roads=[];this._pendingOuter=null;this._pendingWaypoints=[];this._motorwayLine=null;this._motorwayA=null;this._motorwayB=null;this._pendingM1=null;this._pendingM3=null;
      document.getElementById('slipTypePicker')?.remove();
      this._redrawOverlay();document.getElementById('markRoadList').innerHTML='';
      this._updateMarkBadge();
    });
    document.getElementById('modeMotorway').addEventListener('click',()=>{
      this._markingMode='motorway';
      document.getElementById('modeMotorway').classList.add('active');
      document.getElementById('modeIntersection').classList.remove('active');
      this._roads=[];this._pendingOuter=null;this._pendingWaypoints=[];this._motorwayLine=null;this._motorwayA=null;this._motorwayB=null;this._pendingM1=null;this._pendingM3=null;
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
      this._roads=[];this._pendingOuter=null;this._pendingInner=null;this._pendingWaypoints=[];this._motorwayLine=null;this._motorwayA=null;this._motorwayB=null;this._pendingM1=null;this._pendingM3=null;
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

    // ── Motorway carriageway clicks (M1→M2, then M3→M4) ──────
    if(this._markingMode==='motorway'){
      // Phase: collecting carriageway A (M1→M2)
      if(!this._motorwayA){
        if(!this._pendingM1){ this._pendingM1=pt; }
        else{ this._motorwayA={p1:this._pendingM1, p2:pt}; this._pendingM1=null; }
        this._redrawOverlay(); this._updateMarkBadge(); return;
      }
      // Phase: collecting carriageway B (M3→M4)
      if(!this._motorwayB){
        if(!this._pendingM3){ this._pendingM3=pt; }
        else{ this._motorwayB={p1:this._pendingM3, p2:pt}; this._pendingM3=null; }
        this._redrawOverlay(); this._updateMarkBadge(); return;
      }
      // Both carriageways set — now collecting slip roads (fall through below)
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
    // Draw carriageway A (M1→M2) and B (M3→M4)
    const drawCarriageway=(line, labels, col)=>{
      if(!line) return;
      const x1=line.p1.dx*sx, y1=line.p1.dy*sy;
      const x2=line.p2.dx*sx, y2=line.p2.dy*sy;
      ctx.strokeStyle=col; ctx.lineWidth=3; ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
      // Arrow in direction of travel
      const ang=Math.atan2(y2-y1,x2-x1);
      const mx=(x1+x2)/2, my=(y1+y2)/2;
      ctx.save();ctx.translate(mx,my);ctx.rotate(ang);
      ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(8,0);ctx.lineTo(-5,-4);ctx.lineTo(-5,4);ctx.closePath();ctx.fill();
      ctx.restore();
      [[x1,y1,labels[0]],[x2,y2,labels[1]]].forEach(([x,y,lbl])=>{
        ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);
        ctx.fillStyle=col+'cc';ctx.fill();
        ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();
        ctx.fillStyle='#fff';ctx.font='bold 8px sans-serif';
        ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(lbl,x,y);
      });
    };
    drawCarriageway(this._motorwayA,['M1','M2'],'#1d4ed8');
    drawCarriageway(this._motorwayB,['M3','M4'],'#0f766e');
    // Pending first click of each carriageway
    if(!this._motorwayA && this._pendingM1){
      const ox=this._pendingM1.dx*sx, oy=this._pendingM1.dy*sy;
      ctx.beginPath();ctx.arc(ox,oy,8,0,Math.PI*2);ctx.fillStyle='#1d4ed8aa';ctx.fill();
      ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();
      ctx.fillStyle='#fff';ctx.font='bold 8px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('M1',ox,oy);
    }
    if(this._motorwayA && !this._motorwayB && this._pendingM3){
      const ox=this._pendingM3.dx*sx, oy=this._pendingM3.dy*sy;
      ctx.beginPath();ctx.arc(ox,oy,8,0,Math.PI*2);ctx.fillStyle='#0f766eaa';ctx.fill();
      ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();
      ctx.fillStyle='#fff';ctx.font='bold 8px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('M3',ox,oy);
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
    if(this._pendingOuter && this._markingMode==='motorway' && this._motorwayA && this._motorwayB){
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
    } else if(this._pendingOuter && !(this._markingMode==='motorway' && (!this._motorwayA || !this._motorwayB))){
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
      rm.onclick=()=>{this._motorwayLine=null;this._motorwayA=null;this._motorwayB=null;this._pendingM1=null;this._pendingM3=null;this._redrawOverlay();this._updateMarkList();this._updateMarkBadge();};
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

  async _fetchOSM(query){
    const W=document.getElementById('simCanvas')?.parentElement?.clientWidth||800;
    const H=Math.round(W*0.65)||520;
    this._showOverlay('Searching OpenStreetMap…',10);
    try{
      this._updateOverlay('Finding location…',20);
      const loc=await OSMFetcher.geocode(query);
      this._updateOverlay(`Found: ${loc.name.split(',')[0]}. Fetching roads…`,40);
      const osmData=await OSMFetcher.fetchRoads(loc.lat,loc.lon,500);
      this._updateOverlay('Building network…',78);
      this.network=OSMFetcher.buildNetwork(osmData,loc.lat,loc.lon,W,H);
      if(!this.network) throw new Error('No roads found near that location');
      const lbl=this.network.mode==='motorway'
        ?`Motorway: ${this.network.mainRoads.length} carriageways, ${this.network.slipRoads.length} slip roads`
        :'Intersection detected';
      this._updateOverlay(lbl,95);
      await new Promise(r=>setTimeout(r,400));
      this._hideOverlay();
      document.getElementById('uploadZone').style.display='none';
      document.getElementById('previewSection').style.display='';
      document.getElementById('hintText').textContent=`📍 ${loc.name.split(',').slice(0,3).join(',')}`;
      this._finishSetup(W,H);
    }catch(err){
      this._hideOverlay();
      console.error('OSM error:',err);
      document.getElementById('hintText').textContent='⚠ '+err.message;
      document.getElementById('previewSection').style.display='';
      document.getElementById('uploadZone').style.display='none';
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
