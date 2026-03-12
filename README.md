# ⬡ IntersectSim

**Upload a Google Maps screenshot → watch traffic come alive.**

A browser-based intersection traffic simulator that uses Claude AI vision to analyse your map image and build a real physics simulation of vehicle flow, congestion, and signal timing.

👉 **[Live Demo](https://YOUR-USERNAME.github.io/intersect-sim)**

![IntersectSim screenshot](screenshot.png)

---

## What it does

1. **Upload any Google Maps / satellite screenshot** of a road intersection
2. **Claude AI analyses the image** — detecting roads, lane counts, traffic signals, intersection type
3. **A real-time simulation spawns** with colour-coded vehicles navigating the detected road layout
4. **Adjust parameters live**: traffic volume, time of day, signal timing, road rule system, simulation speed
5. **Live metrics**: throughput, average wait time, congestion index, collision risk
6. **Export CSV** of the metrics history

---

## Features

| Feature | Detail |
|---|---|
| 🤖 AI road detection | Claude vision identifies intersection type, lanes, signals |
| 🚗 Physics simulation | Collision avoidance, signal-responsive yielding, lane discipline |
| 🕐 Time of day | Morning rush, evening rush, night — affects spawn rates |
| 🚦 Signal modes | Adaptive, Fixed 30s, Fixed 60s, No signals |
| 🌍 Rule systems | UK/EU, US Grid, Spanish (different hesitation & lane-change behaviour) |
| 📊 Live metrics | Throughput, wait time, queue length, collision risk probability |
| 📈 Sparkline graph | Congestion, throughput, or wait time over time |
| 📥 CSV export | Download metrics history |

---

## Getting started (GitHub Pages hosting)

### Option A — Fork & enable Pages (easiest)

1. Fork this repository
2. Go to **Settings → Pages**
3. Set source to **Deploy from branch → main → / (root)**
4. Visit `https://YOUR-USERNAME.github.io/intersect-sim`

### Option B — Clone & run locally

```bash
git clone https://github.com/YOUR-USERNAME/intersect-sim.git
cd intersect-sim
# Any static file server works:
npx serve .
# or
python3 -m http.server 8080
```
Open `http://localhost:8080`

---

## API Key setup

The AI image analysis uses the **Anthropic Claude API**. You need to add your API key.

### For local development

In `sim.js`, find the fetch call and add your key to the headers:

```js
headers: {
  'Content-Type': 'application/json',
  'x-api-key': 'YOUR_KEY_HERE',          // ← add this
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true'
},
```

### Important security note

**Never commit your API key to a public repo.**  
For a public deployment, set up a small proxy server (Cloudflare Worker, Vercel Edge Function, etc.) that adds the key server-side, then point the fetch in `sim.js` at your proxy URL.

### What happens without an API key?

The app falls back to a standard 4-way intersection model automatically — so the simulation still runs, it just won't reflect your specific uploaded map.

---

## How it works

```
User uploads image
        ↓
ImageAnalyser.analyse()
  → sends base64 image to Claude API
  → Claude returns JSON: { intersectionType, roads[], features[] }
        ↓
RoadNetwork built from JSON
  → road endpoints, lane counts, signal positions computed
        ↓
Simulation initialises
  → TrafficSignal phases built from road structure
  → Vehicles spawned per road arm at configurable rate
        ↓
Per-frame loop (30fps)
  → signal.step() — advance phase timer
  → vehicle.step() — state machine, collision avoidance
  → Renderer draws roads + heatmap + vehicles
  → MetricsTracker records rolling stats
```

### Vehicle state machine

```
APPROACHING → WAITING → CROSSING → EXITING → DONE
                 ↑
           checks signal green
           + checks intersection clear
           + applies rule-system hesitation
```

### Rule system differences

| Parameter | UK/EU | US Grid | Spanish |
|---|---|---|---|
| Lane change probability | 0.3% | 0.8% | 2.5% |
| Entry hesitation mean | 0.4s | 0.5s | 0.9s |
| Conflict delay factor | 0.25× | 0.30× | 0.55× |

---

## File structure

```
intersect-sim/
├── index.html      — Layout and UI structure
├── style.css       — All styling (dark terminal aesthetic)
├── sim.js          — Simulation engine + AI analysis + app controller
└── README.md
```

---

## Tech stack

- **Vanilla JS** — no frameworks, no build step
- **Canvas 2D API** — all rendering
- **Claude claude-sonnet-4-20250514** — image analysis
- **GitHub Pages** — hosting

---

## Licence

MIT — use freely, attribution appreciated.
