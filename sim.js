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
    const net=this.network; this.routeType=routeType;
    const LANES=3,laneSpd=l=>l===0?SPEED.motorwaySlow:l===1?SPEED.motorwayMid:SPEED.motorwayMain;
    const road=net.mainRoads[0];
    const chain0=road.chain0||[{x:road.x1,y:road.y1},{x:road.x2,y:road.y2}];
    const chain1=road.chain1||[...chain0].reverse();
    const laneOff=(pts,lane)=>{
      if(pts.length<2)return{ox:0,oy:0};
      const dx=pts[1].x-pts[0].x,dy=pts[1].y-pts[0].y,len=Math.hypot(dx,dy)||1;
      const d=(lane-(LANES-1)/2)*LANE_W;
      return{ox:(-dy/len)*d,oy:(dx/len)*d};
    };
    if(routeType==='through'){
      const dir=Math.random()<0.5?0:1; const pts=dir===0?chain0:chain1;
      const lane=Math.floor(Math.random()*LANES),spd=laneSpd(lane)*(0.9+Math.random()*0.2);
      const {ox,oy}=laneOff(pts,lane);
      this.x=pts[0].x+ox;this.y=pts[0].y+oy;this.speed=spd;this.laneIdx=lane;
      this.routeDir=dir;this.roadId=road.id;this.isOnSlip=false;
      this.angle=pts.length>1?Math.atan2(pts[1].y-pts[0].y,pts[1].x-pts[0].x):0;
      this.path=pts.slice(1).map((p,i,a)=>({x:p.x+ox,y:p.y+oy,action:i===a.length-1?'DONE':'MOVING',speed:spd}));
    }else if(routeType==='exit'){
      const slip=net.slipRoads.find(s=>s.id===slipId)||net.slipRoads[0];
      if(!slip){this._initMotorway({routeType:'through',mainRoadId:0,slipId:0});return;}
      const d0=chain0.reduce((mn,p)=>Math.min(mn,Math.hypot(p.x-slip.bx,p.y-slip.by)),Infinity);
      const d1=chain1.reduce((mn,p)=>Math.min(mn,Math.hypot(p.x-slip.bx,p.y-slip.by)),Infinity);
      const pts=d0<=d1?chain0:chain1; const {ox,oy}=laneOff(pts,0);
      const spawn=Math.hypot(pts[0].x-slip.bx,pts[0].y-slip.by)>Math.hypot(pts[pts.length-1].x-slip.bx,pts[pts.length-1].y-slip.by)?pts[0]:pts[pts.length-1];
      this.x=spawn.x+ox;this.y=spawn.y+oy;this.speed=SPEED.motorwayMain;
      this.routeDir=d0<=d1?0:1;this.roadId=road.id;this.isOnSlip=false;
      const curve=slip.curve||[];
      this.path=[{x:slip.bx,y:slip.by,action:'DECEL',speed:SPEED.motorwayMain},...curve.map(p=>({x:p.x,y:p.y,action:'MOVING',speed:SPEED.motorwaySlip})),{x:slip.tx,y:slip.ty,action:'DONE',speed:SPEED.motorwaySlip}];
    }else{
      const slip=net.slipRoads.find(s=>s.id===slipId)||net.slipRoads[0];
      if(!slip){this._initMotorway({routeType:'through',mainRoadId:0,slipId:0});return;}
      const d0=chain0.reduce((mn,p)=>Math.min(mn,Math.hypot(p.x-slip.bx,p.y-slip.by)),Infinity);
      const d1=chain1.reduce((mn,p)=>Math.min(mn,Math.hypot(p.x-slip.bx,p.y-slip.by)),Infinity);
      const pts=d0<=d1?chain0:chain1; const {ox,oy}=laneOff(pts,0);
      const exit=Math.hypot(pts[0].x-slip.bx,pts[0].y-slip.by)>Math.hypot(pts[pts.length-1].x-slip.bx,pts[pts.length-1].y-slip.by)?pts[0]:pts[pts.length-1];
      this.x=slip.tx;this.y=slip.ty;
      this.mergeDelay=slip.hasMergeConflict?this.rules.conflictFactor*(1+Math.random()*2):0;
      this.speed=SPEED.motorwaySlip;this.routeDir=d0<=d1?0:1;this.roadId=road.id;this.isOnSlip=true;
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
    const MW=20,SL=10;
    const poly=(pts,lw,col,dash=[])=>{
      if(!pts||pts.length<2)return;
      ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.lineJoin='round';ctx.lineCap='round';
      ctx.setLineDash(dash);ctx.beginPath();
      pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
      ctx.stroke();ctx.setLineDash([]);
    };
    const c0=net.mainRoads[0]?.chain0,c1=net.mainRoads[0]?.chain1;
    // 1. Verges (all)
    poly(c0,MW+18,'#b5c9a5');poly(c1,MW+18,'#b5c9a5');
    net.slipRoads.forEach(s=>poly(s.renderPts,SL+12,'#b5c9a5'));
    // 2. Slip surfaces first so motorway covers the join cleanly
    net.slipRoads.forEach(s=>poly(s.renderPts,SL,'#6e7a8a'));
    // 3. Motorway surface on top
    poly(c0,MW,'#525c6e');poly(c1,MW,'#525c6e');
    // 4. Motorway markings
    poly(c0,1.5,'rgba(255,255,255,0.9)');poly(c1,1.5,'rgba(255,255,255,0.9)');
    poly(c0,1,'rgba(255,255,255,0.4)',[10,8]);poly(c1,1,'rgba(255,255,255,0.4)',[10,8]);
    poly(c0,5,'#6e9458');poly(c1,5,'#6e9458');
    // 5. Slip markings
    net.slipRoads.forEach(s=>poly(s.renderPts,0.8,'rgba(255,255,255,0.6)'));
    // 6. Direction arrows
    [c0,c1].forEach(c=>{
      if(!c||c.length<2)return;
      ctx.fillStyle='rgba(255,255,255,0.4)';let d=0;
      for(let i=1;i<c.length;i++){const dx=c[i].x-c[i-1].x,dy=c[i].y-c[i-1].y;d+=Math.hypot(dx,dy);
        if(d>90){d=0;ctx.save();ctx.translate((c[i].x+c[i-1].x)/2,(c[i].y+c[i-1].y)/2);ctx.rotate(Math.atan2(dy,dx));
          ctx.beginPath();ctx.moveTo(7,0);ctx.lineTo(-4,-3);ctx.lineTo(-4,3);ctx.closePath();ctx.fill();ctx.restore();}}
    });
    net.slipRoads.forEach(s=>{
      const pts=s.renderPts;if(!pts||pts.length<2)return;
      const mi=Math.floor(pts.length*0.5);
      const p0=pts[Math.max(0,mi-1)],p1=pts[Math.min(mi,pts.length-1)];
      ctx.save();ctx.translate((p0.x+p1.x)/2,(p0.y+p1.y)/2);ctx.rotate(Math.atan2(p1.y-p0.y,p1.x-p0.x));
      ctx.fillStyle=s.type==='on-ramp'?'#15803d':'#b45309';
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
  static _BUNDLED=[{lat:39.5853,lon:2.6689,name:'Ma-20/Ma-13 Palma',data:{"elements":[{"type":"way","id":14497820,"nodes":[8230586109,8230586110,8230586105,8230586104],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"3"}},{"type":"way","id":24349137,"nodes":[264139875,11287252791,9826857349,9826857350,8230606938,264139876,8230606940,6093955443,8230606941,6093955444,8230606942,264139877,8230606943,8230606944,6093955445,264139878,8230606945,6093955446,9826857361,8230606946,264139879,6093955447,6093955448,8230606947,264139880,8230606948,1067829971,8230606949,8230606950,8230606951,8230606952,8230606953,264139881,8230606954,8230606955,1067829560],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"2"}},{"type":"way","id":26164200,"nodes":[9826857369,264139890,8235855678,8235855677,8240312854,8240312853,286500727,8240312851,9827624430,9826857388,9826857389,306614461],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"4"}},{"type":"way","id":32692894,"nodes":[142434797,8230352758,8230352759,4200723353,8230352760,8230352761,368232823],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32692930,"nodes":[367891856,26488426],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32692943,"nodes":[4200435761,1885405647,8230249995,8230249994,26488418,8230249996,8230249998,8230249997,8230249999,26488421,8230250000,8230250001,8230339900,26488420,8230339901,8230339902,8230339903,8230339904,8230339905,8230339906,8230339907,4200723347,8230339908,9826857360],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32693095,"nodes":[8230586079,8230586078,3766497759,8230586077,1521661820,8230586076,142434746,9826857351,2999594503,2999594506],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":32693108,"nodes":[264139875,8230606931,1521661840,8230606930,8230606929,8230606928,8230606925,286500799],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32694069,"nodes":[1607665868,1607665889,8231193327,368221811],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32694070,"nodes":[286500799,26488432],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32694095,"nodes":[26488430,8230607020,8230607021,8230607022,8230607023,8230607024,367893783],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32723064,"nodes":[367893783,26488429],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32723330,"nodes":[26488437,368221798],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32723335,"nodes":[26488438,8231207700,8231207699,1607665936,8231207698,1607665943],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32723341,"nodes":[368221798,370532334,8231193338,2999945603],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32723352,"nodes":[368221811,26488438],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32723374,"nodes":[142434768,8230586094,8230586093,8230586092,8230586091,8230586090,8230586089,142434762],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":32755430,"nodes":[26488429,3611361070],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":32755459,"nodes":[26488428,264139875],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":32755606,"nodes":[142434762,8230586087,142434757,8230586086,8230586084,142434755,142434754,1521661825,142434750],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":68543819,"nodes":[26488430,11287220051,8230607001,264139895,8230607000,8230606999,4200716677,8230606998,264139896],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":159951503,"nodes":[286500741,8235855713,286500751,8235855714,29768778],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"3"}},{"type":"way","id":234741405,"nodes":[264139896,8230606996,4200716676,8230606995,264139897,8230606994,1521661817,264139898,8230606993,264139899,8230606992,264139900],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":296169586,"nodes":[264139900,8230606991,264139901,8230606990,4200716674,8230606989,264139902,8230606988,8230606987,4200716675,286500759,8230607025,8230606986,8230607026,8230606985,264139904,8230606984,264139905,8230606983,8230606982,264139906],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":296169588,"nodes":[2999594506,11287252796,11287252794,3611361070],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":296169591,"nodes":[8230606978,264139908,8230606977,8230606976,8230606975,264139909,8230606974,8230606973],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":355543627,"nodes":[26488426,8230352798,8230352797,8230352796,8230352795,367891858,8230352811,264139874,1247184634],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":355543628,"nodes":[9826857352,9826857353,9826857354,9826857355,9826857356,9826857357],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":364802605,"nodes":[26488424,8230339913,8230339914,367891856],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":364802606,"nodes":[4200723348,9826857359,26488423,8230250002,8230250003,8230250005,8230250004,12378764260,26488422,8230250006,8230250008,8230250007,8230250010,8230250009,26488419,8230250011],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":366695896,"nodes":[2997420514,8230249989,8230249987,8230249985,8230249983,8230249981,8230249978,8230249980,8230249979,26488416],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":420059640,"nodes":[26488416,4200435761],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":420065806,"nodes":[2999945603,9826857347,8230607016,8230607017,8230607018,8230607008],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":420065812,"nodes":[8230606924,1607665868],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":420091507,"nodes":[293028192,8231207687,8231207688,8231207689,26488437],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":420092965,"nodes":[368232823,26488425,4200723348],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":885061650,"nodes":[8230607008,9826857348],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":885291924,"nodes":[1247184634,26488428],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":885692898,"nodes":[1521661842,11287252784,11287252786,11287252788,11287252790,264139886],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":885692899,"nodes":[8230606973,264139910],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":885692900,"nodes":[8230606957,8230606958,1067829874,8230606959,264139883,8230606960,11287252778,11287252785,11287252787,11287252789,264139886],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"2"}},{"type":"way","id":885692901,"nodes":[1067829560,8235817993,8235817994,8230606957],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"2"}},{"type":"way","id":885692904,"nodes":[142434776,11287220049,11287220048,751220061,8230586097,8230586096,8230586095,142434768],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":885692905,"nodes":[8230586104,8235817995,142434776],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"3"}},{"type":"way","id":1005903211,"nodes":[8230250011,10878022346,10878022347,9829273958,9829273956,9829273957,10878022348,10878022349,4769989039],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":1070825186,"nodes":[8240312874,8240312872,251689165,251689166,8240312867,29768780,8240312865,8240312864,9827624431,8240312863,9826857329],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"3"}},{"type":"way","id":1070825187,"nodes":[9826857329,9827624429,560441186],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"4"}},{"type":"way","id":1070825190,"nodes":[560441186,286500731,8240312855,8235855766,8235855724,29768779,286500662],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"3"}},{"type":"way","id":1070825191,"nodes":[286500662,9826857338,9826857339,286500741],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"4"}},{"type":"way","id":1070825193,"nodes":[29768778,142434781,9826857340,8230586109],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"3"}},{"type":"way","id":1070825195,"nodes":[26488432,8230606924],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"3"}},{"type":"way","id":1070825196,"nodes":[9826857348,26488430],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":1070825197,"nodes":[3611361070,9826857352],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":1070825198,"nodes":[9826857357,9826857358],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":1070825199,"nodes":[9826857358,142434797],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":1070825200,"nodes":[9826857360,26488424],"tags":{"highway":"motorway","ref":"Ma-20","oneway":"yes","lanes":"4"}},{"type":"way","id":1070825201,"nodes":[264139906,8230606981,8230606980,264139907,8230606979,8230606978],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":1070825202,"nodes":[264139910,1521661842],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":1070825203,"nodes":[306614461,8240312911,264139893,8240312912,8240312915,251689139,286500722,8240315318,8240315319,9826857370],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"3"}},{"type":"way","id":1070825213,"nodes":[264139886,9826857362,11287252783,11287252782,264139888],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"4"}},{"type":"way","id":1070825214,"nodes":[264139888,9826857368,9826857369],"tags":{"highway":"motorway","ref":"Ma-13","oneway":"yes","lanes":"5"}},{"type":"way","id":1070826268,"nodes":[142434750,8230586080,8230586079],"tags":{"highway":"motorway","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":14493321,"nodes":[8230352751,142434810,8230352750,8230352749,142434813,8230352745,142434816,8230352746,142434823,8230352747,8230352748,142434829],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"3"}},{"type":"way","id":26163926,"nodes":[142434776,11287220047,11287220046,11287220045,286500771,1521661841,286500777,8230606920,8230606921,286500784,286500790,286500795,9826857346,6385449452],"tags":{"highway":"motorway_link","ref":"Ma-13","oneway":"yes","lanes":"1"}},{"type":"way","id":26717899,"nodes":[293028192,4200716678,8231207692,8231207691,8231207690,293028388],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":27935381,"nodes":[306614483,2612029680,306614484,8240315368,8240315369,306614485,8240315370,2612029678,8240315371,8240315372,8240315373,306614486,8240315374,8240315375,8240315376,8240315377,8240315378],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":32692965,"nodes":[26488424,268880864,8230352717,4200723354,8230339916,8230339915,268880865,268880866,1247184718,268880867],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":32724603,"nodes":[9831877072,9831877079,9831877075,8230352770,368232813,8230352771,8230352772,368232814,8230352773,368232815,8230352774,8230352775,4200723349,8230352776,368232816,368232817,8230352777,8230352778,368232818,368232819,4200723351,8230352779,368232820,4200723350,368232823],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":44098154,"nodes":[560441186,560441188,8235855758,8235855757,8235855756,560441189,8235855755,8235855754,560441190,8235855753,8235855752,8235855751,560441191,8235855750,8235855749,560441192,8235855748,8235855747,2999677838,2999677515],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":44098161,"nodes":[1521661842,11287252777,11287252776,560441240,2999677889,2999677870,8235818009,2999677841,2999677529,8235818006,8235818007,2999677890,8235818008,560441243],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":147561201,"nodes":[1607665868,11287220053,4200490614,1607665899,8231193329,8231193330,8231193336,1607665925],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":296169587,"nodes":[8230436634,9831877068,9724748330,8230352825,2999594517,8230352814,367892594],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":296169589,"nodes":[1247184720,8230436625,2999594491,8230352816,8230352817,2999594502,8230352818,367892594],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":296169590,"nodes":[9831832603,367892595,8230352813,8230352812,11287252792,11287252793,1247184634],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":296175360,"nodes":[2999677853,8235855746,8235855664,2999677888,8235855737,2999677876,8235855736,2999677523,8235855735,8235855734,2999677527,2999677868,8235855733,8235855732,2999677503,8235855731,8235855730,2999677839,286500662],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":296175368,"nodes":[560441222,2999677499,8235855462,8235855461,8235855463,2999677847,2999677524,5837257663,2999677531,2999677859,8235855686,11287252779,11287252780,11287252781,264139888],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":296201348,"nodes":[8231193360,8231193369,8231193344,8231193372,8231193373,8231193374,2999945587,2999945598,2999945592,2999945602,2999945603],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":296201352,"nodes":[1607665925,1607665929,8231193331,8231207629,8231207628,1607665932,8231207615,8231207616,8231207630,4408148971],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":""}},{"type":"way","id":296201354,"nodes":[3623394434,8231207607,8231207606,8231207595,8231207594,9286418321,5715159844,8231207679,8231207680,8231207681,293028395,372502007,293028396,8231207682,1607665937,8231233886,1607665943],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":355548964,"nodes":[142434829,3611419652,8230352767,8230352766,3710278094,3611419653,8230407411,3898982941],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":356939549,"nodes":[293028388,8231207693,3623394426,8231207694,8231207695,8231207697,9286418323,8231207563,8231207696,3623394427,8231207564,8231207565,8231207566,8231207567,8231207568,8231207569,8231207570,8231207571],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":""}},{"type":"way","id":405515923,"nodes":[8230250011,10878022345,10878022344,10878022343,4769989029,4077070071,4769989028,4077070070],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":681848243,"nodes":[6385449452,4200490613],"tags":{"highway":"motorway_link","ref":"Ma-13","oneway":"yes","lanes":"1"}},{"type":"way","id":885036317,"nodes":[142434797,1765329899],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":885043798,"nodes":[8230352784,8230436649,8230436654,8230436650],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":885061648,"nodes":[4200490613,11287220050,8230606924],"tags":{"highway":"motorway_link","ref":"Ma-13","oneway":"yes","lanes":"1"}},{"type":"way","id":1070825204,"nodes":[306614461,306614483],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"1"}},{"type":"way","id":1071375844,"nodes":[367892594,9831832603],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"2"}},{"type":"way","id":1071375846,"nodes":[1765329899,142434802,8230352753,8230352752,142434809,8230352751],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"3"}},{"type":"way","id":1071375847,"nodes":[142434829,264139833,8230352784],"tags":{"highway":"motorway_link","ref":"","oneway":"yes","lanes":"3"}},{"type":"node","id":4200435761,"lat":39.5774664,"lon":2.6763768},{"type":"node","id":8230606920,"lat":39.5879239,"lon":2.6659494},{"type":"node","id":8230606921,"lat":39.5879303,"lon":2.6658401},{"type":"node","id":8230352766,"lat":39.5832339,"lon":2.6699297},{"type":"node","id":8230606924,"lat":39.5884393,"lon":2.6647579},{"type":"node","id":8230606925,"lat":39.5878599,"lon":2.665436},{"type":"node","id":8230606928,"lat":39.5876473,"lon":2.6657035},{"type":"node","id":8230606929,"lat":39.5874292,"lon":2.6659852},{"type":"node","id":8230606930,"lat":39.5873266,"lon":2.6661191},{"type":"node","id":8230606931,"lat":39.5869041,"lon":2.6666957},{"type":"node","id":8230606938,"lat":39.5869858,"lon":2.6668456},{"type":"node","id":8230606940,"lat":39.5871066,"lon":2.666815},{"type":"node","id":8230606941,"lat":39.5871846,"lon":2.6668114},{"type":"node","id":8230606942,"lat":39.5872606,"lon":2.666824},{"type":"node","id":8230606943,"lat":39.5873387,"lon":2.6668496},{"type":"node","id":8230606944,"lat":39.5873826,"lon":2.6668706},{"type":"node","id":8230606945,"lat":39.587499,"lon":2.6669531},{"type":"node","id":8230606946,"lat":39.5875944,"lon":2.6670676},{"type":"node","id":8230606947,"lat":39.5876987,"lon":2.6672968},{"type":"node","id":8230606948,"lat":39.5877265,"lon":2.6674353},{"type":"node","id":8230606949,"lat":39.5877706,"lon":2.6679109},{"type":"node","id":8230606950,"lat":39.5877779,"lon":2.6679719},{"type":"node","id":8230606951,"lat":39.5877913,"lon":2.668076},{"type":"node","id":8230606952,"lat":39.5878124,"lon":2.6682114},{"type":"node","id":8230606953,"lat":39.5878326,"lon":2.6683319},{"type":"node","id":8230606954,"lat":39.5878847,"lon":2.668604},{"type":"node","id":8230606955,"lat":39.5879125,"lon":2.6687367},{"type":"node","id":8235855462,"lat":39.5894072,"lon":2.671756},{"type":"node","id":8230606957,"lat":39.58807,"lon":2.6692551},{"type":"node","id":8230606958,"lat":39.58813,"lon":2.6694019},{"type":"node","id":8230606959,"lat":39.5882781,"lon":2.6697199},{"type":"node","id":8230606960,"lat":39.5884668,"lon":2.670076},{"type":"node","id":8235855461,"lat":39.5894148,"lon":2.671729},{"type":"node","id":367892594,"lat":39.5844484,"lon":2.6706009},{"type":"node","id":367892595,"lat":39.5847929,"lon":2.6699781},{"type":"node","id":8230606973,"lat":39.5878962,"lon":2.6694204},{"type":"node","id":8230606974,"lat":39.5877869,"lon":2.6692923},{"type":"node","id":8230606975,"lat":39.5876217,"lon":2.6691221},{"type":"node","id":8230606976,"lat":39.5875345,"lon":2.6690411},{"type":"node","id":8230606977,"lat":39.5874527,"lon":2.6689704},{"type":"node","id":8230606978,"lat":39.5872684,"lon":2.6688248},{"type":"node","id":8230606979,"lat":39.5871827,"lon":2.6687614},{"type":"node","id":8230606980,"lat":39.5869924,"lon":2.6686336},{"type":"node","id":8230606981,"lat":39.5868007,"lon":2.6685236},{"type":"node","id":8230606982,"lat":39.5865018,"lon":2.6683472},{"type":"node","id":8230606983,"lat":39.5864235,"lon":2.668296},{"type":"node","id":8230606984,"lat":39.5862341,"lon":2.6681562},{"type":"node","id":8230606985,"lat":39.5861177,"lon":2.6680455},{"type":"node","id":8230606986,"lat":39.5859691,"lon":2.6678725},{"type":"node","id":8230606987,"lat":39.5857873,"lon":2.6675681},{"type":"node","id":8230606988,"lat":39.5857712,"lon":2.6675219},{"type":"node","id":8230606989,"lat":39.5857112,"lon":2.6672715},{"type":"node","id":8230606990,"lat":39.5856985,"lon":2.6669917},{"type":"node","id":8230606991,"lat":39.5857397,"lon":2.6667121},{"type":"node","id":8230606992,"lat":39.5858373,"lon":2.6664525},{"type":"node","id":8230606993,"lat":39.585981,"lon":2.6662317},{"type":"node","id":8230606994,"lat":39.5862559,"lon":2.666004},{"type":"node","id":8230606995,"lat":39.5864667,"lon":2.6659098},{"type":"node","id":8230606996,"lat":39.5866789,"lon":2.6658413},{"type":"node","id":8230606998,"lat":39.5870981,"lon":2.6657164},{"type":"node","id":8230606999,"lat":39.5872294,"lon":2.6656575},{"type":"node","id":8230607000,"lat":39.5872849,"lon":2.6656256},{"type":"node","id":8230607001,"lat":39.5874046,"lon":2.6655408},{"type":"node","id":8230607008,"lat":39.588049,"lon":2.6649622},{"type":"node","id":8230607016,"lat":39.5883914,"lon":2.6645846},{"type":"node","id":8230607017,"lat":39.5882787,"lon":2.6647193},{"type":"node","id":8230607018,"lat":39.5881479,"lon":2.6648644},{"type":"node","id":8230607020,"lat":39.5875095,"lon":2.6656614},{"type":"node","id":8230607021,"lat":39.5871872,"lon":2.6660784},{"type":"node","id":8230607022,"lat":39.5869694,"lon":2.6663718},{"type":"node","id":8230607023,"lat":39.5866663,"lon":2.6667915},{"type":"node","id":8230607024,"lat":39.5864634,"lon":2.6670748},{"type":"node","id":8230607025,"lat":39.5859003,"lon":2.667776},{"type":"node","id":8230607026,"lat":39.586051,"lon":2.6679691},{"type":"node","id":251689139,"lat":39.5961265,"lon":2.6735702},{"type":"node","id":306614461,"lat":39.5947114,"lon":2.6730341},{"type":"node","id":1607665868,"lat":39.5898498,"lon":2.6631194},{"type":"node","id":251689165,"lat":39.5961404,"lon":2.6733646},{"type":"node","id":251689166,"lat":39.595869,"lon":2.673238},{"type":"node","id":306614483,"lat":39.595005,"lon":2.6732738},{"type":"node","id":306614484,"lat":39.5952691,"lon":2.6735466},{"type":"node","id":306614485,"lat":39.5954765,"lon":2.6738832},{"type":"node","id":306614486,"lat":39.5958626,"lon":2.6746564},{"type":"node","id":1607665889,"lat":39.5903548,"lon":2.6625045},{"type":"node","id":1607665899,"lat":39.5910697,"lon":2.6619913},{"type":"node","id":2612029678,"lat":39.5956068,"lon":2.6741777},{"type":"node","id":2612029680,"lat":39.5951517,"lon":2.6734114},{"type":"node","id":1607665925,"lat":39.5920754,"lon":2.6609897},{"type":"node","id":1607665929,"lat":39.5921389,"lon":2.6609465},{"type":"node","id":1607665932,"lat":39.5923608,"lon":2.6608549},{"type":"node","id":1607665936,"lat":39.5935358,"lon":2.6590832},{"type":"node","id":1607665937,"lat":39.5937399,"lon":2.659019},{"type":"node","id":1607665943,"lat":39.594367,"lon":2.6582362},{"type":"node","id":1067829560,"lat":39.587944,"lon":2.6688694},{"type":"node","id":8231233886,"lat":39.5942554,"lon":2.6584807},{"type":"node","id":293028192,"lat":39.5936986,"lon":2.6587122},{"type":"node","id":9829273956,"lat":39.5768018,"lon":2.6763955},{"type":"node","id":9829273957,"lat":39.5765034,"lon":2.6764449},{"type":"node","id":9829273958,"lat":39.5770533,"lon":2.6763342},{"type":"node","id":368232813,"lat":39.582803,"lon":2.6701696},{"type":"node","id":368232814,"lat":39.5827021,"lon":2.6703453},{"type":"node","id":368232815,"lat":39.5826676,"lon":2.670474},{"type":"node","id":368232816,"lat":39.5826913,"lon":2.6708201},{"type":"node","id":9826857329,"lat":39.5941788,"lon":2.6726634},{"type":"node","id":368232817,"lat":39.5827256,"lon":2.6709094},{"type":"node","id":6093955443,"lat":39.5871478,"lon":2.6668116},{"type":"node","id":6093955444,"lat":39.5872202,"lon":2.6668152},{"type":"node","id":6093955445,"lat":39.5874264,"lon":2.6668959},{"type":"node","id":6093955446,"lat":39.5875308,"lon":2.6669853},{"type":"node","id":368232823,"lat":39.5825723,"lon":2.6718636},{"type":"node","id":6093955448,"lat":39.5876775,"lon":2.6672299},{"type":"node","id":6093955447,"lat":39.5876525,"lon":2.667171},{"type":"node","id":9826857338,"lat":39.5907774,"lon":2.6715836},{"type":"node","id":9826857339,"lat":39.5903763,"lon":2.6713706},{"type":"node","id":9826857340,"lat":39.5886736,"lon":2.6695298},{"type":"node","id":368232820,"lat":39.582769,"lon":2.6714398},{"type":"node","id":8235855463,"lat":39.5894243,"lon":2.6717059},{"type":"node","id":2999945598,"lat":39.5904689,"lon":2.6618929},{"type":"node","id":2999945592,"lat":39.5901815,"lon":2.6623177},{"type":"node","id":4200716674,"lat":39.5856982,"lon":2.6671313},{"type":"node","id":9826857347,"lat":39.5885103,"lon":2.6644408},{"type":"node","id":9826857348,"lat":39.5879327,"lon":2.6651008},{"type":"node","id":2999945603,"lat":39.5897513,"lon":2.6629798},{"type":"node","id":4200716676,"lat":39.5865745,"lon":2.665872},{"type":"node","id":9826857349,"lat":39.5868345,"lon":2.6669442},{"type":"node","id":9826857350,"lat":39.5869092,"lon":2.6668757},{"type":"node","id":9826857351,"lat":39.5861052,"lon":2.6671693},{"type":"node","id":4200716677,"lat":39.5871647,"lon":2.6656882},{"type":"node","id":9826857355,"lat":39.5845903,"lon":2.6696712},{"type":"node","id":9826857356,"lat":39.5842736,"lon":2.6700762},{"type":"node","id":9826857357,"lat":39.5841003,"lon":2.6702834},{"type":"node","id":9826857352,"lat":39.5855374,"lon":2.6683646},{"type":"node","id":9826857359,"lat":39.5803175,"lon":2.674064},{"type":"node","id":9826857353,"lat":39.5852061,"lon":2.6688193},{"type":"node","id":9826857354,"lat":39.5849033,"lon":2.6692394},{"type":"node","id":9826857361,"lat":39.587561,"lon":2.6670229},{"type":"node","id":9826857360,"lat":39.5821807,"lon":2.6724531},{"type":"node","id":9826857358,"lat":39.5836842,"lon":2.6707495},{"type":"node","id":9826857362,"lat":39.5895972,"lon":2.6714256},{"type":"node","id":9826857368,"lat":39.590759,"lon":2.6720583},{"type":"node","id":9826857369,"lat":39.5910609,"lon":2.6721169},{"type":"node","id":9826857370,"lat":39.5972085,"lon":2.6741539},{"type":"node","id":4769989028,"lat":39.5756747,"lon":2.6762916},{"type":"node","id":4769989029,"lat":39.576757,"lon":2.6762251},{"type":"node","id":9826857388,"lat":39.5940061,"lon":2.6728218},{"type":"node","id":9826857389,"lat":39.594289,"lon":2.6729048},{"type":"node","id":4769989039,"lat":39.5755653,"lon":2.676458},{"type":"node","id":142434746,"lat":39.5861513,"lon":2.6670363},{"type":"node","id":142434750,"lat":39.5867539,"lon":2.666243},{"type":"node","id":142434754,"lat":39.5869829,"lon":2.6661796},{"type":"node","id":142434755,"lat":39.5870932,"lon":2.6661763},{"type":"node","id":142434757,"lat":39.5874223,"lon":2.6662761},{"type":"node","id":142434762,"lat":39.5875626,"lon":2.6663875},{"type":"node","id":9831877068,"lat":39.584241,"lon":2.6708364},{"type":"node","id":3710278094,"lat":39.5832724,"lon":2.6699248},{"type":"node","id":1885405647,"lat":39.5776136,"lon":2.6763139},{"type":"node","id":142434768,"lat":39.5878391,"lon":2.666763},{"type":"node","id":9831877072,"lat":39.5831127,"lon":2.6697978},{"type":"node","id":9831877075,"lat":39.5830477,"lon":2.6699029},{"type":"node","id":9831877079,"lat":39.583082,"lon":2.6698522},{"type":"node","id":142434776,"lat":39.5881157,"lon":2.6680002},{"type":"node","id":142434781,"lat":39.5888537,"lon":2.6698493},{"type":"node","id":3766497759,"lat":39.5864166,"lon":2.6665512},{"type":"node","id":2997420514,"lat":39.5757973,"lon":2.6766433},{"type":"node","id":6385449452,"lat":39.588122,"lon":2.6652851},{"type":"node","id":142434797,"lat":39.5833728,"lon":2.671069},{"type":"node","id":142434802,"lat":39.5830774,"lon":2.6710892},{"type":"node","id":142434809,"lat":39.5828946,"lon":2.6710013},{"type":"node","id":142434810,"lat":39.5828042,"lon":2.6708844},{"type":"node","id":142434813,"lat":39.5827314,"lon":2.6706378},{"type":"node","id":142434816,"lat":39.5827435,"lon":2.6704752},{"type":"node","id":142434823,"lat":39.5827994,"lon":2.6703159},{"type":"node","id":142434829,"lat":39.5831121,"lon":2.6699606},{"type":"node","id":8230352784,"lat":39.5832358,"lon":2.6697989},{"type":"node","id":8240312851,"lat":39.593438,"lon":2.6726647},{"type":"node","id":8240312853,"lat":39.592859,"lon":2.6725199},{"type":"node","id":8240312854,"lat":39.5925686,"lon":2.6724522},{"type":"node","id":8240312855,"lat":39.5926171,"lon":2.6722017},{"type":"node","id":3898982941,"lat":39.5834297,"lon":2.669934},{"type":"node","id":8240312863,"lat":39.5944597,"lon":2.672747},{"type":"node","id":8240312864,"lat":39.594745,"lon":2.6728324},{"type":"node","id":8240312865,"lat":39.5950233,"lon":2.672918},{"type":"node","id":8240312867,"lat":39.595591,"lon":2.6731227},{"type":"node","id":293028388,"lat":39.5924708,"lon":2.6597384},{"type":"node","id":8240312872,"lat":39.5964204,"lon":2.6734956},{"type":"node","id":8240312874,"lat":39.5966922,"lon":2.6736397},{"type":"node","id":9724748330,"lat":39.5842705,"lon":2.6708213},{"type":"node","id":293028395,"lat":39.592824,"lon":2.6602151},{"type":"node","id":293028396,"lat":39.5932242,"lon":2.6596776},{"type":"node","id":2999677499,"lat":39.589404,"lon":2.671783},{"type":"node","id":2999677503,"lat":39.5917542,"lon":2.6716997},{"type":"node","id":2999677515,"lat":39.5926536,"lon":2.6706451},{"type":"node","id":8240312911,"lat":39.5950281,"lon":2.6731319},{"type":"node","id":8240312912,"lat":39.5955704,"lon":2.6733322},{"type":"node","id":8240312915,"lat":39.5958481,"lon":2.6734514},{"type":"node","id":2999677523,"lat":39.5922425,"lon":2.6713281},{"type":"node","id":2999677524,"lat":39.589458,"lon":2.6716684},{"type":"node","id":2999677527,"lat":39.5920213,"lon":2.6715587},{"type":"node","id":2999677529,"lat":39.5890454,"lon":2.6714132},{"type":"node","id":2999677531,"lat":39.5895144,"lon":2.6716331},{"type":"node","id":11287252781,"lat":39.5904548,"lon":2.6720452},{"type":"node","id":11287252782,"lat":39.5900902,"lon":2.6717773},{"type":"node","id":1067829874,"lat":39.5881969,"lon":2.669551},{"type":"node","id":8231207563,"lat":39.5915606,"lon":2.6605411},{"type":"node","id":8231207564,"lat":39.5914954,"lon":2.660587},{"type":"node","id":8231207565,"lat":39.5914711,"lon":2.6605965},{"type":"node","id":8231207566,"lat":39.591445,"lon":2.6606002},{"type":"node","id":8231207567,"lat":39.5912174,"lon":2.6606092},{"type":"node","id":8231207568,"lat":39.5911826,"lon":2.6606092},{"type":"node","id":8231207569,"lat":39.5911568,"lon":2.6606068},{"type":"node","id":8231207570,"lat":39.5911274,"lon":2.6606007},{"type":"node","id":8231207571,"lat":39.5910609,"lon":2.6605779},{"type":"node","id":8231207594,"lat":39.5927779,"lon":2.6603601},{"type":"node","id":8231207595,"lat":39.5927829,"lon":2.6603875},{"type":"node","id":8231207606,"lat":39.5927914,"lon":2.6604133},{"type":"node","id":8231207607,"lat":39.59281,"lon":2.6604467},{"type":"node","id":8231207615,"lat":39.5925211,"lon":2.6608414},{"type":"node","id":8231207616,"lat":39.5925522,"lon":2.6608448},{"type":"node","id":10878022343,"lat":39.5771101,"lon":2.6761976},{"type":"node","id":10878022344,"lat":39.5772796,"lon":2.676162},{"type":"node","id":10878022345,"lat":39.5775222,"lon":2.6761098},{"type":"node","id":10878022346,"lat":39.5775385,"lon":2.6761503},{"type":"node","id":10878022347,"lat":39.5772556,"lon":2.6762684},{"type":"node","id":10878022348,"lat":39.5761343,"lon":2.6764717},{"type":"node","id":10878022349,"lat":39.5757271,"lon":2.6764652},{"type":"node","id":8231207629,"lat":39.5922587,"lon":2.6608778},{"type":"node","id":8231207628,"lat":39.5923116,"lon":2.6608616},{"type":"node","id":8231207630,"lat":39.5925814,"lon":2.6608528},{"type":"node","id":1067829971,"lat":39.5877621,"lon":2.6678323},{"type":"node","id":560441222,"lat":39.5894061,"lon":2.671831},{"type":"node","id":8231193327,"lat":39.5906002,"lon":2.6622337},{"type":"node","id":8231193329,"lat":39.5916071,"lon":2.6614555},{"type":"node","id":8231193330,"lat":39.5918685,"lon":2.6611959},{"type":"node","id":8231193331,"lat":39.5922088,"lon":2.6609038},{"type":"node","id":8231193336,"lat":39.5920025,"lon":2.6610586},{"type":"node","id":8231193338,"lat":39.5900867,"lon":2.6626079},{"type":"node","id":8231207679,"lat":39.5927779,"lon":2.6603045},{"type":"node","id":8231193344,"lat":39.5909045,"lon":2.6610824},{"type":"node","id":8231207680,"lat":39.592785,"lon":2.6602782},{"type":"node","id":8231207681,"lat":39.5927981,"lon":2.66025},{"type":"node","id":8231207682,"lat":39.593548,"lon":2.6592492},{"type":"node","id":8231207687,"lat":39.5934681,"lon":2.6589478},{"type":"node","id":8231207688,"lat":39.5932217,"lon":2.659201},{"type":"node","id":8231207689,"lat":39.592751,"lon":2.6596932},{"type":"node","id":8231207690,"lat":39.5927759,"lon":2.6594797},{"type":"node","id":8231207691,"lat":39.5928954,"lon":2.6593752},{"type":"node","id":8231207692,"lat":39.5930851,"lon":2.6591979},{"type":"node","id":8231207693,"lat":39.5918512,"lon":2.6602476},{"type":"node","id":8231207694,"lat":39.59175,"lon":2.660338},{"type":"node","id":8231207695,"lat":39.5916847,"lon":2.6604059},{"type":"node","id":8231193360,"lat":39.5908961,"lon":2.6609897},{"type":"node","id":8231207697,"lat":39.5915825,"lon":2.6605188},{"type":"node","id":8231207698,"lat":39.5937704,"lon":2.6588401},{"type":"node","id":8231207699,"lat":39.5932895,"lon":2.6593376},{"type":"node","id":8231207700,"lat":39.592941,"lon":2.659699},{"type":"node","id":8231207696,"lat":39.5915412,"lon":2.6605585},{"type":"node","id":8231193369,"lat":39.5909034,"lon":2.6610485},{"type":"node","id":8231193372,"lat":39.5909064,"lon":2.6611169},{"type":"node","id":8231193373,"lat":39.5909044,"lon":2.6611559},{"type":"node","id":8231193374,"lat":39.5908971,"lon":2.6611906},{"type":"node","id":5715159844,"lat":39.5927765,"lon":2.6603328},{"type":"node","id":3623394427,"lat":39.5915208,"lon":2.6605733},{"type":"node","id":2999945587,"lat":39.5908786,"lon":2.6612367},{"type":"node","id":2999677838,"lat":39.5925737,"lon":2.6710137},{"type":"node","id":2999677839,"lat":39.5915124,"lon":2.6717364},{"type":"node","id":2999677841,"lat":39.5890416,"lon":2.6713415},{"type":"node","id":4200723347,"lat":39.5810108,"lon":2.6736081},{"type":"node","id":4200723348,"lat":39.5809358,"lon":2.6734511},{"type":"node","id":4200723349,"lat":39.5826621,"lon":2.6706899},{"type":"node","id":4200723350,"lat":39.5827383,"lon":2.671511},{"type":"node","id":4200723351,"lat":39.5828058,"lon":2.6712853},{"type":"node","id":2999677847,"lat":39.5894376,"lon":2.6716877},{"type":"node","id":4200723353,"lat":39.5829841,"lon":2.6714615},{"type":"node","id":4200723354,"lat":39.5833277,"lon":2.6716328},{"type":"node","id":2999677853,"lat":39.5926312,"lon":2.6704892},{"type":"node","id":2999677859,"lat":39.589559,"lon":2.6716188},{"type":"node","id":2999677868,"lat":39.5919466,"lon":2.6716144},{"type":"node","id":2999677870,"lat":39.5890074,"lon":2.6712226},{"type":"node","id":2999677876,"lat":39.5923514,"lon":2.671157},{"type":"node","id":8240315318,"lat":39.596671,"lon":2.6738485},{"type":"node","id":8240315319,"lat":39.596913,"lon":2.6739819},{"type":"node","id":5837257663,"lat":39.5894869,"lon":2.6716506},{"type":"node","id":2999677888,"lat":39.592446,"lon":2.6709439},{"type":"node","id":2999677889,"lat":39.5889777,"lon":2.6711447},{"type":"node","id":2999677890,"lat":39.5890262,"lon":2.6715415},{"type":"node","id":2999945602,"lat":39.5901153,"lon":2.6624143},{"type":"node","id":268880864,"lat":39.5831177,"lon":2.6717465},{"type":"node","id":268880865,"lat":39.5836667,"lon":2.6714955},{"type":"node","id":268880866,"lat":39.5837787,"lon":2.6714471},{"type":"node","id":268880867,"lat":39.5840314,"lon":2.6713021},{"type":"node","id":12378764260,"lat":39.5788423,"lon":2.6753266},{"type":"node","id":8240315368,"lat":39.5953453,"lon":2.6736522},{"type":"node","id":8240315369,"lat":39.5954135,"lon":2.6737619},{"type":"node","id":8240315370,"lat":39.5955354,"lon":2.6740094},{"type":"node","id":8240315371,"lat":39.5956635,"lon":2.6743048},{"type":"node","id":8240315372,"lat":39.5957234,"lon":2.6744271},{"type":"node","id":8240315373,"lat":39.5957895,"lon":2.6745436},{"type":"node","id":8240315374,"lat":39.595937,"lon":2.6747607},{"type":"node","id":8240315375,"lat":39.596016,"lon":2.6748654},{"type":"node","id":8240315376,"lat":39.5960928,"lon":2.6749579},{"type":"node","id":8240315377,"lat":39.5961765,"lon":2.6750506},{"type":"node","id":8240315378,"lat":39.5963133,"lon":2.6751841},{"type":"node","id":4408148971,"lat":39.5926488,"lon":2.6608839},{"type":"node","id":1765329899,"lat":39.5831481,"lon":2.6710921},{"type":"node","id":3611419652,"lat":39.5831614,"lon":2.6699467},{"type":"node","id":3611419653,"lat":39.5833172,"lon":2.669921},{"type":"node","id":8235817993,"lat":39.5879829,"lon":2.6690067},{"type":"node","id":8235817994,"lat":39.5880221,"lon":2.6691277},{"type":"node","id":8235817995,"lat":39.5881387,"lon":2.6680999},{"type":"node","id":8235818006,"lat":39.5890412,"lon":2.6714685},{"type":"node","id":8235818007,"lat":39.5890372,"lon":2.6714989},{"type":"node","id":8235818008,"lat":39.5890128,"lon":2.6715712},{"type":"node","id":8235818009,"lat":39.5890297,"lon":2.6712879},{"type":"node","id":9831832603,"lat":39.5847019,"lon":2.6701426},{"type":"node","id":264139833,"lat":39.58321,"lon":2.6698307},{"type":"node","id":29768778,"lat":39.5890533,"lon":2.6701529},{"type":"node","id":29768779,"lat":39.5914808,"lon":2.6718581},{"type":"node","id":29768780,"lat":39.5953087,"lon":2.6730171},{"type":"node","id":264139874,"lat":39.5854338,"lon":2.6687788},{"type":"node","id":264139875,"lat":39.5866117,"lon":2.667126},{"type":"node","id":264139876,"lat":39.58705,"lon":2.6668267},{"type":"node","id":264139877,"lat":39.5873004,"lon":2.666835},{"type":"node","id":264139878,"lat":39.5874626,"lon":2.6669206},{"type":"node","id":264139879,"lat":39.5876238,"lon":2.6671144},{"type":"node","id":264139880,"lat":39.5877138,"lon":2.6673602},{"type":"node","id":264139881,"lat":39.5878579,"lon":2.6684681},{"type":"node","id":264139883,"lat":39.5883509,"lon":2.6698623},{"type":"node","id":264139886,"lat":39.5893198,"lon":2.6712242},{"type":"node","id":264139888,"lat":39.590627,"lon":2.6720159},{"type":"node","id":264139890,"lat":39.5913919,"lon":2.6721908},{"type":"node","id":264139893,"lat":39.5952898,"lon":2.6732256},{"type":"node","id":264139895,"lat":39.5873421,"lon":2.6655887},{"type":"node","id":264139896,"lat":39.5868904,"lon":2.6657833},{"type":"node","id":264139897,"lat":39.5863622,"lon":2.6659503},{"type":"node","id":264139898,"lat":39.5860684,"lon":2.6661415},{"type":"node","id":264139899,"lat":39.5859041,"lon":2.6663368},{"type":"node","id":264139900,"lat":39.5857812,"lon":2.6665786},{"type":"node","id":264139901,"lat":39.5857138,"lon":2.6668497},{"type":"node","id":264139902,"lat":39.5857391,"lon":2.6674151},{"type":"node","id":3623394426,"lat":39.5917965,"lon":2.6602946},{"type":"node","id":264139904,"lat":39.5861592,"lon":2.6680891},{"type":"node","id":264139905,"lat":39.586324,"lon":2.6682273},{"type":"node","id":264139906,"lat":39.5866112,"lon":2.6684144},{"type":"node","id":264139907,"lat":39.5870885,"lon":2.6686964},{"type":"node","id":264139908,"lat":39.5873602,"lon":2.6688953},{"type":"node","id":264139909,"lat":39.587708,"lon":2.6692079},{"type":"node","id":264139910,"lat":39.5879934,"lon":2.6695369},{"type":"node","id":3623394434,"lat":39.5928429,"lon":2.6604924},{"type":"node","id":8230407411,"lat":39.5833717,"lon":2.6699236},{"type":"node","id":367893783,"lat":39.586238,"lon":2.667381},{"type":"node","id":8235855754,"lat":39.5927188,"lon":2.671888},{"type":"node","id":8230339900,"lat":39.5796327,"lon":2.674901},{"type":"node","id":8230339901,"lat":39.5798979,"lon":2.6746711},{"type":"node","id":8230339902,"lat":39.5800244,"lon":2.6745601},{"type":"node","id":8230339903,"lat":39.580153,"lon":2.674442},{"type":"node","id":8230339904,"lat":39.5802763,"lon":2.6743266},{"type":"node","id":8230339905,"lat":39.5803979,"lon":2.6742107},{"type":"node","id":8230339906,"lat":39.5805209,"lon":2.6740901},{"type":"node","id":8230339907,"lat":39.580767,"lon":2.6738493},{"type":"node","id":8230339908,"lat":39.5813817,"lon":2.6732411},{"type":"node","id":8230339913,"lat":39.5830796,"lon":2.6715646},{"type":"node","id":8230339914,"lat":39.5835813,"lon":2.6710605},{"type":"node","id":8230339915,"lat":39.5835137,"lon":2.6715507},{"type":"node","id":8230339916,"lat":39.583419,"lon":2.671588},{"type":"node","id":751220061,"lat":39.5879849,"lon":2.6672402},{"type":"node","id":8235855664,"lat":39.5924831,"lon":2.6708449},{"type":"node","id":368232818,"lat":39.5827961,"lon":2.67111},{"type":"node","id":368232819,"lat":39.5828076,"lon":2.6711907},{"type":"node","id":367891856,"lat":39.5837689,"lon":2.67087},{"type":"node","id":367891858,"lat":39.584787,"lon":2.6696516},{"type":"node","id":9827624429,"lat":39.5938024,"lon":2.6725514},{"type":"node","id":9827624430,"lat":39.5937427,"lon":2.6727495},{"type":"node","id":9827624431,"lat":39.5947312,"lon":2.6728283},{"type":"node","id":372502007,"lat":39.5930379,"lon":2.6599249},{"type":"node","id":8230249978,"lat":39.5768626,"lon":2.6765481},{"type":"node","id":8230249979,"lat":39.5771654,"lon":2.6764789},{"type":"node","id":8230249980,"lat":39.5770194,"lon":2.6765162},{"type":"node","id":8230249981,"lat":39.5767191,"lon":2.6765719},{"type":"node","id":2999594491,"lat":39.5843545,"lon":2.6709379},{"type":"node","id":8230249983,"lat":39.5765699,"lon":2.6765887},{"type":"node","id":8230249985,"lat":39.5764185,"lon":2.6766014},{"type":"node","id":8230249987,"lat":39.5762603,"lon":2.6766071},{"type":"node","id":8230249989,"lat":39.5761091,"lon":2.676609},{"type":"node","id":2999594502,"lat":39.5843771,"lon":2.6708096},{"type":"node","id":2999594503,"lat":39.5860689,"lon":2.6673054},{"type":"node","id":8230249994,"lat":39.5778856,"lon":2.676169},{"type":"node","id":8230249995,"lat":39.5777474,"lon":2.676248},{"type":"node","id":8230249996,"lat":39.5781633,"lon":2.6759903},{"type":"node","id":8230249997,"lat":39.5784329,"lon":2.675801},{"type":"node","id":8230249998,"lat":39.5782956,"lon":2.6758983},{"type":"node","id":8230249999,"lat":39.578709,"lon":2.6756049},{"type":"node","id":8230250000,"lat":39.5792166,"lon":2.6752293},{"type":"node","id":8230250001,"lat":39.579374,"lon":2.6751078},{"type":"node","id":2999594506,"lat":39.5860356,"lon":2.6674436},{"type":"node","id":8230250002,"lat":39.5793168,"lon":2.6749697},{"type":"node","id":8230250003,"lat":39.5791922,"lon":2.6750666},{"type":"node","id":8230250005,"lat":39.5790659,"lon":2.6751621},{"type":"node","id":8230250004,"lat":39.5789315,"lon":2.6752618},{"type":"node","id":8230250006,"lat":39.5786627,"lon":2.6754561},{"type":"node","id":8230250008,"lat":39.5785356,"lon":2.6755485},{"type":"node","id":8230250007,"lat":39.578403,"lon":2.6756425},{"type":"node","id":8230250010,"lat":39.5782685,"lon":2.6757361},{"type":"node","id":8230250009,"lat":39.5781315,"lon":2.675827},{"type":"node","id":8230250011,"lat":39.5778329,"lon":2.6760109},{"type":"node","id":2999594517,"lat":39.5843218,"lon":2.6707781},{"type":"node","id":4200716675,"lat":39.5858233,"lon":2.6676493},{"type":"node","id":26488416,"lat":39.5773134,"lon":2.6764332},{"type":"node","id":26488418,"lat":39.5780263,"lon":2.6760822},{"type":"node","id":26488419,"lat":39.577993,"lon":2.6759154},{"type":"node","id":26488420,"lat":39.5797668,"lon":2.6747852},{"type":"node","id":26488421,"lat":39.5789765,"lon":2.6754101},{"type":"node","id":368221798,"lat":39.5913357,"lon":2.661211},{"type":"node","id":26488423,"lat":39.5797354,"lon":2.6746054},{"type":"node","id":26488422,"lat":39.5787966,"lon":2.6753598},{"type":"node","id":26488425,"lat":39.5818848,"lon":2.6725256},{"type":"node","id":26488426,"lat":39.5841857,"lon":2.6704054},{"type":"node","id":26488424,"lat":39.5827162,"lon":2.671925},{"type":"node","id":26488428,"lat":39.5861649,"lon":2.6677753},{"type":"node","id":26488429,"lat":39.5860932,"lon":2.6675797},{"type":"node","id":26488430,"lat":39.5878981,"lon":2.6651387},{"type":"node","id":4200716678,"lat":39.5932724,"lon":2.6590121},{"type":"node","id":26488432,"lat":39.588172,"lon":2.6650685},{"type":"node","id":368221811,"lat":39.5914072,"lon":2.6613395},{"type":"node","id":26488437,"lat":39.5923953,"lon":2.6600711},{"type":"node","id":26488438,"lat":39.5924682,"lon":2.6601991},{"type":"node","id":4200490614,"lat":39.5904497,"lon":2.6626112},{"type":"node","id":4200490613,"lat":39.5882349,"lon":2.6651372},{"type":"node","id":8235855730,"lat":39.5916005,"lon":2.6717274},{"type":"node","id":8235855734,"lat":39.5920962,"lon":2.6714967},{"type":"node","id":8230586076,"lat":39.5861936,"lon":2.6669245},{"type":"node","id":8230586077,"lat":39.5863413,"lon":2.6666618},{"type":"node","id":8230586078,"lat":39.5865027,"lon":2.666448},{"type":"node","id":8230586079,"lat":39.5865849,"lon":2.6663632},{"type":"node","id":8230586080,"lat":39.5866697,"lon":2.6662953},{"type":"node","id":8230586084,"lat":39.5872116,"lon":2.6661958},{"type":"node","id":8230586086,"lat":39.5873247,"lon":2.6662286},{"type":"node","id":8230586087,"lat":39.5875003,"lon":2.6663327},{"type":"node","id":8230586089,"lat":39.5876095,"lon":2.6664302},{"type":"node","id":8230586090,"lat":39.5876724,"lon":2.6665029},{"type":"node","id":8230586091,"lat":39.5877081,"lon":2.6665451},{"type":"node","id":8230586092,"lat":39.5877558,"lon":2.6666112},{"type":"node","id":8230586093,"lat":39.5877834,"lon":2.6666555},{"type":"node","id":8230586094,"lat":39.5878171,"lon":2.6667159},{"type":"node","id":8230586095,"lat":39.5878767,"lon":2.6668441},{"type":"node","id":8230586096,"lat":39.5879178,"lon":2.6669479},{"type":"node","id":8230586097,"lat":39.5879499,"lon":2.6670624},{"type":"node","id":8230352752,"lat":39.5829546,"lon":2.6710459},{"type":"node","id":4077070070,"lat":39.5754874,"lon":2.6763175},{"type":"node","id":4077070071,"lat":39.5762164,"lon":2.6762471},{"type":"node","id":8230586104,"lat":39.5881717,"lon":2.6682348},{"type":"node","id":8230586105,"lat":39.5882455,"lon":2.668487},{"type":"node","id":1247184634,"lat":39.5856416,"lon":2.6685061},{"type":"node","id":8230586109,"lat":39.5885106,"lon":2.6691974},{"type":"node","id":8230586110,"lat":39.588365,"lon":2.6688483},{"type":"node","id":8235855746,"lat":39.5925106,"lon":2.6707749},{"type":"node","id":8235855747,"lat":39.5925612,"lon":2.6711003},{"type":"node","id":8235855748,"lat":39.5925532,"lon":2.6711688},{"type":"node","id":8230436625,"lat":39.5843546,"lon":2.6709975},{"type":"node","id":8235855749,"lat":39.5925502,"lon":2.6713133},{"type":"node","id":9826857346,"lat":39.5880366,"lon":2.6654066},{"type":"node","id":8230436634,"lat":39.5842074,"lon":2.6708503},{"type":"node","id":8235855750,"lat":39.5925549,"lon":2.6714},{"type":"node","id":8235855751,"lat":39.5925841,"lon":2.6715732},{"type":"node","id":8235855752,"lat":39.5926062,"lon":2.6716466},{"type":"node","id":11287252776,"lat":39.5886456,"lon":2.6705953},{"type":"node","id":11287252777,"lat":39.5884972,"lon":2.6703557},{"type":"node","id":11287252778,"lat":39.5886319,"lon":2.6703556},{"type":"node","id":8235855753,"lat":39.5926337,"lon":2.6717223},{"type":"node","id":11287252779,"lat":39.5899361,"lon":2.6717924},{"type":"node","id":11287252780,"lat":39.5902206,"lon":2.6719511},{"type":"node","id":3611361070,"lat":39.5859248,"lon":2.6677868},{"type":"node","id":11287252783,"lat":39.589804,"lon":2.6715866},{"type":"node","id":11287252784,"lat":39.5885704,"lon":2.6703837},{"type":"node","id":11287252785,"lat":39.5887716,"lon":2.6705485},{"type":"node","id":11287252786,"lat":39.5887036,"lon":2.6705707},{"type":"node","id":11287252787,"lat":39.5889444,"lon":2.6707621},{"type":"node","id":11287252788,"lat":39.5888997,"lon":2.6708263},{"type":"node","id":11287252789,"lat":39.5891879,"lon":2.6710414},{"type":"node","id":11287252790,"lat":39.5891654,"lon":2.6711206},{"type":"node","id":11287252791,"lat":39.5867096,"lon":2.6670737},{"type":"node","id":286500662,"lat":39.5911618,"lon":2.6717449},{"type":"node","id":11287252792,"lat":39.5854274,"lon":2.6689298},{"type":"node","id":11287252794,"lat":39.5859579,"lon":2.6676197},{"type":"node","id":11287252793,"lat":39.5855825,"lon":2.6686943},{"type":"node","id":11287252796,"lat":39.5860071,"lon":2.6675451},{"type":"node","id":8235855677,"lat":39.5922767,"lon":2.6723882},{"type":"node","id":8235855678,"lat":39.5917122,"lon":2.6722614},{"type":"node","id":8230352767,"lat":39.5832022,"lon":2.6699357},{"type":"node","id":8235855686,"lat":39.5896734,"lon":2.671651},{"type":"node","id":11287220045,"lat":39.5880267,"lon":2.6672583},{"type":"node","id":11287220046,"lat":39.5880598,"lon":2.6674697},{"type":"node","id":11287220047,"lat":39.5881173,"lon":2.6678553},{"type":"node","id":11287220048,"lat":39.5880299,"lon":2.6675971},{"type":"node","id":11287220049,"lat":39.5880629,"lon":2.6677756},{"type":"node","id":8230352717,"lat":39.5832265,"lon":2.6716864},{"type":"node","id":11287220051,"lat":39.5876544,"lon":2.6653284},{"type":"node","id":1247184718,"lat":39.5839099,"lon":2.6713781},{"type":"node","id":11287220053,"lat":39.5901088,"lon":2.6629581},{"type":"node","id":1247184720,"lat":39.5843599,"lon":2.6710696},{"type":"node","id":11287220050,"lat":39.5884149,"lon":2.6649147},{"type":"node","id":8235855713,"lat":39.5897402,"lon":2.6709128},{"type":"node","id":8235855714,"lat":39.5892782,"lon":2.6704327},{"type":"node","id":560441186,"lat":39.5932973,"lon":2.6724012},{"type":"node","id":560441188,"lat":39.5930292,"lon":2.6722159},{"type":"node","id":560441189,"lat":39.5928196,"lon":2.6720289},{"type":"node","id":560441190,"lat":39.5926736,"lon":2.6718107},{"type":"node","id":560441191,"lat":39.5925674,"lon":2.6714962},{"type":"node","id":560441192,"lat":39.5925501,"lon":2.671242},{"type":"node","id":8230352745,"lat":39.5827327,"lon":2.6705539},{"type":"node","id":8230352746,"lat":39.5827665,"lon":2.6703879},{"type":"node","id":8230352747,"lat":39.5828427,"lon":2.6702493},{"type":"node","id":8235855724,"lat":39.5918957,"lon":2.6719901},{"type":"node","id":8230352749,"lat":39.5827413,"lon":2.6707251},{"type":"node","id":8230352750,"lat":39.5827675,"lon":2.6708087},{"type":"node","id":8230352751,"lat":39.5828468,"lon":2.6709486},{"type":"node","id":8230352748,"lat":39.5828905,"lon":2.6701942},{"type":"node","id":8230352753,"lat":39.5830169,"lon":2.6710738},{"type":"node","id":286500722,"lat":39.5964019,"lon":2.6737042},{"type":"node","id":8235855731,"lat":39.5916806,"lon":2.6717173},{"type":"node","id":8235855732,"lat":39.5918237,"lon":2.6716797},{"type":"node","id":8235855733,"lat":39.5918884,"lon":2.671649},{"type":"node","id":8230352758,"lat":39.5832258,"lon":2.6712193},{"type":"node","id":286500727,"lat":39.5931454,"lon":2.6725907},{"type":"node","id":8230352759,"lat":39.5831025,"lon":2.6713412},{"type":"node","id":8230352760,"lat":39.5827484,"lon":2.6716931},{"type":"node","id":8230352761,"lat":39.582621,"lon":2.6718175},{"type":"node","id":286500731,"lat":39.592992,"lon":2.6723107},{"type":"node","id":1521661820,"lat":39.586262,"lon":2.6667879},{"type":"node","id":1521661817,"lat":39.5861596,"lon":2.6660668},{"type":"node","id":8235855737,"lat":39.5923967,"lon":2.671063},{"type":"node","id":8235855736,"lat":39.5923028,"lon":2.6712414},{"type":"node","id":8235855735,"lat":39.5921726,"lon":2.6714199},{"type":"node","id":1521661825,"lat":39.5868696,"lon":2.6662025},{"type":"node","id":8230352770,"lat":39.5828496,"lon":2.6701171},{"type":"node","id":8230352771,"lat":39.5827633,"lon":2.6702243},{"type":"node","id":8230352772,"lat":39.5827299,"lon":2.6702828},{"type":"node","id":286500741,"lat":39.5900022,"lon":2.6711267},{"type":"node","id":8230352773,"lat":39.5826809,"lon":2.6704066},{"type":"node","id":8230352774,"lat":39.5826593,"lon":2.6705485},{"type":"node","id":8230352775,"lat":39.5826561,"lon":2.6706149},{"type":"node","id":8230352776,"lat":39.5826733,"lon":2.6707604},{"type":"node","id":8230352777,"lat":39.5827559,"lon":2.6709788},{"type":"node","id":8230352778,"lat":39.5827789,"lon":2.6710408},{"type":"node","id":8230352779,"lat":39.5827915,"lon":2.6713657},{"type":"node","id":8235855757,"lat":39.5929116,"lon":2.6721211},{"type":"node","id":8235855758,"lat":39.5929621,"lon":2.6721629},{"type":"node","id":286500751,"lat":39.5894982,"lon":2.6706807},{"type":"node","id":1521661840,"lat":39.5872079,"lon":2.6662776},{"type":"node","id":1521661841,"lat":39.5879462,"lon":2.6663813},{"type":"node","id":1521661842,"lat":39.5884391,"lon":2.6701605},{"type":"node","id":8235855756,"lat":39.5928653,"lon":2.6720782},{"type":"node","id":8235855755,"lat":39.592766,"lon":2.6719613},{"type":"node","id":9286418321,"lat":39.5927774,"lon":2.6603512},{"type":"node","id":8235855766,"lat":39.5923168,"lon":2.6721211},{"type":"node","id":286500759,"lat":39.5858364,"lon":2.667673},{"type":"node","id":560441240,"lat":39.5889175,"lon":2.671018},{"type":"node","id":9286418323,"lat":39.5915707,"lon":2.6605308},{"type":"node","id":8230352795,"lat":39.584651,"lon":2.6698185},{"type":"node","id":8230352796,"lat":39.584536,"lon":2.6699684},{"type":"node","id":8230352797,"lat":39.5844233,"lon":2.6701139},{"type":"node","id":8230352798,"lat":39.5843062,"lon":2.6702603},{"type":"node","id":560441243,"lat":39.5889576,"lon":2.6716459},{"type":"node","id":286500771,"lat":39.5879719,"lon":2.6668002},{"type":"node","id":286500777,"lat":39.5879257,"lon":2.666067},{"type":"node","id":8230352811,"lat":39.5853156,"lon":2.6689097},{"type":"node","id":8230352812,"lat":39.5851795,"lon":2.6693131},{"type":"node","id":8230352813,"lat":39.5849785,"lon":2.6696534},{"type":"node","id":8230352814,"lat":39.5843676,"lon":2.6707163},{"type":"node","id":286500784,"lat":39.5879421,"lon":2.665737},{"type":"node","id":8230352816,"lat":39.5843578,"lon":2.6708991},{"type":"node","id":8230352817,"lat":39.5843677,"lon":2.6708487},{"type":"node","id":8230352818,"lat":39.5844057,"lon":2.6707135},{"type":"node","id":286500790,"lat":39.5879625,"lon":2.6656276},{"type":"node","id":8230352825,"lat":39.5842909,"lon":2.6708077},{"type":"node","id":286500795,"lat":39.5879849,"lon":2.6655395},{"type":"node","id":286500799,"lat":39.5880505,"lon":2.6652234},{"type":"node","id":8230436649,"lat":39.5832555,"lon":2.66977},{"type":"node","id":8230436650,"lat":39.583275,"lon":2.6696975},{"type":"node","id":8230436654,"lat":39.5832673,"lon":2.6697348},{"type":"node","id":370532334,"lat":39.5901959,"lon":2.6624869}]}}];
  static _parseDMS(s){const m=s.match(/(\d+)[°\s]+(\d+)['\s]+(\d+\.?\d*)["\s]*([NS])[,\s]+(\d+)[°\s]+(\d+)['\s]+(\d+\.?\d*)["\s]*([EW])/i);if(!m)return null;return{lat:(+m[1]+(+m[2])/60+(+m[3])/3600)*(m[4].toUpperCase()==='S'?-1:1),lon:(+m[5]+(+m[6])/60+(+m[7])/3600)*(m[8].toUpperCase()==='W'?-1:1)};}
  static async geocode(query){
    const md=query.trim().match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);if(md)return{lat:+md[1],lon:+md[2],name:query};
    const dms=OSMFetcher._parseDMS(query);if(dms)return{lat:dms.lat,lon:dms.lon,name:`${dms.lat.toFixed(5)},${dms.lon.toFixed(5)}`};
    const r=await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=en`,{headers:{'User-Agent':'IntersectSim/1.0'}});
    if(!r.ok)throw new Error(`Nominatim error: ${r.status}`);const d=await r.json();
    if(!d.length)throw new Error(`Location not found: "${query}"`);
    return{lat:+d[0].lat,lon:+d[0].lon,name:d[0].display_name};
  }
  static async fetchRoads(lat,lon,radius=500){
    for(const b of OSMFetcher._BUNDLED){const dist=Math.hypot((lat-b.lat)*111320,(lon-b.lon)*111320*Math.cos(lat*Math.PI/180));if(dist<1000){console.log(`Bundled: ${b.name}`);return b.data;}}
    const sv=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
    const dl=radius/111320,dn=radius/(111320*Math.cos(lat*Math.PI/180)),bb=`${lat-dl},${lon-dn},${lat+dl},${lon+dn}`;
    const qm=`[out:json][timeout:30];(way["highway"="motorway"](${bb});way["highway"="motorway_link"](${bb});way["highway"="trunk"](${bb});way["highway"="trunk_link"](${bb}););out body;`;
    const qu=`[out:json][timeout:30];(way["highway"="primary"](${bb});way["highway"="secondary"](${bb}););out body;`;
    let le;
    for(const s of sv){try{
      const r1=await fetch(s,{method:'POST',body:'data='+encodeURIComponent(qm),signal:AbortSignal.timeout(25000)});if(!r1.ok)throw new Error(`HTTP ${r1.status}`);
      let ws=((await r1.json()).elements||[]).filter(e=>e.type==='way');
      if(!ws.filter(w=>w.tags&&(w.tags.highway==='motorway'||w.tags.highway==='trunk')).length){const ru=await fetch(s,{method:'POST',body:'data='+encodeURIComponent(qu),signal:AbortSignal.timeout(25000)});if(!ru.ok)throw new Error(`HTTP ${ru.status}`);ws=((await ru.json()).elements||[]).filter(e=>e.type==='way');}
      const ni=[...new Set(ws.flatMap(w=>w.nodes||[]))];
      const r2=await fetch(s,{method:'POST',body:'data='+encodeURIComponent(`[out:json][timeout:30];node(id:${ni.join(',')});out skel;`),signal:AbortSignal.timeout(25000)});if(!r2.ok)throw new Error(`HTTP ${r2.status}`);
      return{elements:[...ws,...((await r2.json()).elements||[])]};
    }catch(e){le=e;console.warn(`Overpass ${s}:`,e.message);}}
    throw new Error('Overpass unavailable.('+le?.message+')');
  }

  // BFS: group ways that share nodes into connected components
  static _groupWays(ways) {
    const wayIds=new Set(ways.map(w=>w.id));
    const wayMap={};
    ways.forEach(w=>{wayMap[w.id]=w;});
    // Build node→wayId map (only for ways in our set)
    const nodeWays={};
    ways.forEach(w=>w.nodes.forEach(n=>{(nodeWays[n]=nodeWays[n]||[]).push(w.id);}));
    // Build adjacency (only between ways in our set)
    const adj={};
    ways.forEach(w=>{adj[w.id]=new Set();});
    Object.values(nodeWays).forEach(ids=>{
      for(let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++){
        if(adj[ids[i]]&&adj[ids[j]]){
          adj[ids[i]].add(ids[j]); adj[ids[j]].add(ids[i]);
        }
      }
    });
    // BFS to find connected components
    const visited=new Set(), groups=[];
    ways.forEach(w=>{
      if(visited.has(w.id)) return;
      const grp=[], queue=[w.id];
      while(queue.length){
        const id=queue.pop();
        if(visited.has(id)||!wayMap[id]) continue;
        visited.add(id); grp.push(wayMap[id]);
        if(adj[id]) adj[id].forEach(nb=>{if(!visited.has(nb)&&wayMap[nb])queue.push(nb);});
      }
      if(grp.length>0) groups.push(grp);
    });
    return groups;
  }

  // Stitch a group of connected ways into one ordered polyline
  static _stitchGroup(grpWays, nodePt) {
    const gs={}, ge={};
    grpWays.forEach(w=>{gs[w.nodes[0]]=w; ge[w.nodes[w.nodes.length-1]]=w;});
    const head=grpWays.find(w=>!ge[w.nodes[0]])||grpWays[0];
    const ids=[], seen=new Set(); let cur=head;
    while(cur&&!seen.has(cur.id)){
      seen.add(cur.id);
      ids.push(...(ids.length?cur.nodes.slice(1):cur.nodes));
      cur=gs[cur.nodes[cur.nodes.length-1]];
    }
    grpWays.filter(w=>!seen.has(w.id)).forEach(w=>ids.push(...w.nodes));
    return ids.map(nid=>nodePt(nid)).filter(p=>p&&!isNaN(p.x));
  }

  static buildNetwork(osmData,lat,lon,W,H) {
    const elements=osmData.elements||[];
    const nodeMap={};
    elements.filter(e=>e.type==='node').forEach(n=>{nodeMap[n.id]=n;});
    const ways=elements.filter(e=>e.type==='way'&&e.nodes&&e.tags);
    const mwWays=ways.filter(w=>w.tags.highway==='motorway'||w.tags.highway==='trunk');
    const lkWays=ways.filter(w=>w.tags.highway==='motorway_link'||w.tags.highway==='trunk_link');
    const iS=Math.min(W,H)/2/500,cosL=Math.cos(lat*Math.PI/180);
    const ip=(nLat,nLon)=>({x:W/2+(nLon-lon)*111320*cosL*iS,y:H/2-(nLat-lat)*111320*iS});
    // Fit to ALL road nodes (motorway + links) with generous padding
    const allRoadWays=[...mwWays,...lkWays];
    const fitPts=[];
    allRoadWays.forEach(w=>w.nodes.forEach(nid=>{const n=nodeMap[nid];if(n)fitPts.push(ip(n.lat,n.lon));}));
    let scale=iS,cx=W/2,cy=H/2;
    if(fitPts.length>1){
      const pad=50,xs=fitPts.map(p=>p.x),ys=fitPts.map(p=>p.y);
      const fitS=Math.min((W-2*pad)/(Math.max(...xs)-Math.min(...xs)),(H-2*pad)/(Math.max(...ys)-Math.min(...ys)));
      scale=iS*fitS;
      // Centre the data in the canvas
      cx=W/2-((Math.min(...xs)+Math.max(...xs))/2-W/2)*fitS;
      cy=H/2-((Math.min(...ys)+Math.max(...ys))/2-H/2)*fitS;
    }
    const project=(nLat,nLon)=>({x:cx+(nLon-lon)*111320*cosL*scale,y:cy-(nLat-lat)*111320*scale});
    const nodePt=nid=>{const n=nodeMap[nid];return n?project(n.lat,n.lon):null;};
    if(mwWays.length>0||lkWays.length>0) return OSMFetcher._buildMotorway(mwWays,lkWays,nodePt,W,H);
    return OSMFetcher._buildIntersection(ways,nodeMap,project,lat,lon,W,H);
  }

  static _buildMotorway(mwWays,lkWays,nodePt,W,H) {
    const byRef={};
    mwWays.forEach(w=>{const r=w.tags.ref||w.tags.name||'?';(byRef[r]=byRef[r]||[]).push(w);});
    const dominant=Object.values(byRef).sort((a,b)=>b.length-a.length)[0]||mwWays;
    const byS={},endSet=new Set();
    dominant.forEach(w=>{byS[w.nodes[0]]=w;endSet.add(w.nodes[w.nodes.length-1]);});
    const trStarts=dominant.map(w=>w.nodes[0]).filter(n=>!endSet.has(n));
    const trWays=s=>{const ws=[],seen=new Set();let c=byS[s];while(c&&!seen.has(c.id)){seen.add(c.id);ws.push(c);c=byS[c.nodes[c.nodes.length-1]];}return ws;};
    const chains=trStarts.slice(0,2).map(s=>trWays(s));
    const polys=chains.map(wl=>{const pts=[];wl.forEach(w=>{const wp=w.nodes.map(nid=>nodePt(nid)).filter(p=>p&&!isNaN(p.x));pts.push(...(pts.length?wp.slice(1):wp));});return pts;}).filter(p=>p.length>=2);
    const main=polys[0]||[{x:0,y:H/2},{x:W,y:H/2}];
    const allMWPts=[];
    mwWays.forEach(w=>w.nodes.forEach(nid=>{const p=nodePt(nid);if(p&&!isNaN(p.x))allMWPts.push(p);}));
    const nearMW=pt=>allMWPts.reduce((mn,p)=>Math.min(mn,Math.hypot(p.x-pt.x,p.y-pt.y)),Infinity);
    const snap=pt=>{let best=pt,bD=Infinity;polys.forEach(poly=>{for(let i=1;i<poly.length;i++){const a=poly[i-1],b=poly[i],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;const t=l2?Math.max(0,Math.min(1,((pt.x-a.x)*dx+(pt.y-a.y)*dy)/l2)):0;const sx=a.x+t*dx,sy=a.y+t*dy,d=Math.hypot(pt.x-sx,pt.y-sy);if(d<bD){bD=d;best={x:sx,y:sy};}}});return best;};
    const mainRoads=[{id:0,name:'Dual Carriageway',x1:main[0].x,y1:main[0].y,x2:main[main.length-1].x,y2:main[main.length-1].y,
      angleRad:Math.atan2(main[main.length-1].y-main[0].y,main[main.length-1].x-main[0].x),
      lanes:3,lanesEachWay:3,speedLimit:120,roadType:'motorway',
      chain0:polys[0]||main,chain1:polys[1]?[...polys[1]].reverse():polys[0]||main}];
    const nearbyLk=lkWays.filter(w=>{
      const pts=w.nodes.map(nid=>nodePt(nid)).filter(p=>p&&!isNaN(p.x));
      return pts.length>=2&&Math.min(nearMW(pts[0]),nearMW(pts[pts.length-1]))<=25;
    });
    const groups=OSMFetcher._groupWays(nearbyLk);
    const slipRoads=groups.map((grp,i)=>{
      const pts=OSMFetcher._stitchGroup(grp,nodePt);
      if(pts.length<2)return null;
      const ds=nearMW(pts[0]),de=nearMW(pts[pts.length-1]);
      const type=ds<=de?'off-ramp':'on-ramp';
      const renderPts=[...pts.map(p=>({x:p.x,y:p.y}))];
      if(type==='off-ramp') renderPts[0]=snap(pts[0]);
      else renderPts[renderPts.length-1]=snap(pts[pts.length-1]);
      const bPt=type==='off-ramp'?renderPts[0]:renderPts[renderPts.length-1];
      const tPt=type==='off-ramp'?renderPts[renderPts.length-1]:renderPts[0];
      return{id:i,type,fromRoadId:0,toRoadId:0,hasMergeConflict:type==='on-ramp',
        bx:bPt.x,by:bPt.y,tx:tPt.x,ty:tPt.y,slipLen:Math.hypot(tPt.x-bPt.x,tPt.y-bPt.y),
        curve:pts.slice(1,-1).map(p=>({x:p.x,y:p.y})),renderPts};
    }).filter(Boolean);
    console.log(`OSM: ${mwWays.length} mw, ${lkWays.length} lk → ${nearbyLk.length} nearby → ${groups.length} groups → ${slipRoads.length} slips`);
    return{mode:'motorway',junctionType:'interchange',mainRoads,slipRoads,cx:W/2,cy:H/2,
      speedLimit:120,features:['OpenStreetMap data',`${dominant.length} motorway ways`,`${slipRoads.length} slip roads`],confidence:1.0};
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
        ?`Motorway: ${this.network.slipRoads.length} slip roads detected`
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
