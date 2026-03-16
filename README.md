# ⬡ IntersectSim

**Search a junction, upload a screenshot, or mark roads manually — watch traffic come alive.**

A browser-based traffic simulator supporting both urban intersections and motorway interchanges. Powered by OpenStreetMap data, Claude AI vision, and a real-time vehicle physics engine.

👉 **[Live Demo](https://jamesbarnard.github.io/intersect-sim)**

---

## What it does

1. **Search any location** using OpenStreetMap — no API key, no screenshot needed
2. **Or upload a Google Maps / satellite screenshot** and let Claude AI analyse it
3. **Or mark roads manually** by clicking directly on the map preview
4. A real-time simulation spawns with colour-coded vehicles navigating the exact road layout
5. Adjust traffic volume, time of day, road rules, and speed live
6. View live metrics and export as CSV

---

## Three ways to load a junction

### 1 — OpenStreetMap search (recommended)
Type a location name (e.g. `Ma-20 Palma junction`) into the search box and press **Go**. The sim fetches real road geometry from OpenStreetMap — curved carriageways, correct lane counts, slip roads, speed limits — all automatically. Free, no API key needed.

### 2 — Upload a screenshot
Drop or click to upload a Google Maps or satellite image. With an Anthropic API key the sim uses Claude AI to auto-detect the road layout. Without a key you can mark roads manually (see below).

### 3 — Manual road marking
After uploading a screenshot, use the road marking tool to click road positions directly on the map:

**Intersection mode**
- Click the outer end of each road arm (A, B, C…)
- Then click where it meets the junction (1, 2, 3…)
- Click **Build Simulation**

**Motorway mode**
- Click **M1** then **M2** along the inner edge of carriageway A (in the direction of traffic flow)
- Click **M3** then **M4** along the inner edge of carriageway B (opposite direction)
- For each slip road: click the tip, then intermediate points along the road, then where it meets the motorway
- Press **↓ Done — Exit** or **↑ Done — Entry** to set the ramp type
- Click **Build Simulation**

---

## Features

| Feature | Detail |
|---|---|
| 🗺 OpenStreetMap import | Real road geometry, lane counts, speed limits — no API key needed |
| 🤖 AI road detection | Claude vision identifies intersection type, lanes, signals from screenshots |
| ⇉ Motorway mode | Dual carriageways, slip roads, on-ramps, off-ramps, per-lane speeds |
| ⊕ Intersection mode | T-junctions, 4-way, complex junctions, roundabouts |
| 📍 Manual marking | Click roads directly on your map for precise control |
| 🚗 Physics simulation | Collision avoidance, signal-responsive yielding, bridge/tunnel logic |
| 🕐 Time of day | Morning rush, evening rush, night — affects spawn rates |
| 🚦 Signal modes | Adaptive, Fixed 30s, Fixed 60s, No signals |
| 🌍 Rule systems | UK/EU, US Grid, Spanish (different hesitation & lane-change behaviour) |
| 🏎 Lane speed rules | Motorway: slow lane 80, middle 90, fast lane 100 km/h (Spanish standard) |
| 📊 Live metrics | Throughput, wait time, queue length, collision risk |
| 📈 Sparkline graph | Congestion, throughput, or wait time over time |
| 📥 CSV export | Download full metrics history |

---

## Getting started

### Option A — Fork & enable Pages (easiest)

1. Fork this repository
2. Go to **Settings → Pages**
3. Set source to **Deploy from branch → main → / (root)**
4. Visit `https://YOUR-USERNAME.github.io/intersect-sim`

### Option B — Clone & run locally

```bash
git clone https://github.com/jamesbarnard/intersect-sim.git
cd intersect-sim
npx serve .
# or
python3 -m http.server 8080
```
Open `http://localhost:8080`

---

## API Key (optional)

An Anthropic API key unlocks AI auto-detection from uploaded screenshots. Without it, OpenStreetMap search and manual road marking still work fully.

Get a key at [console.anthropic.com](https://console.anthropic.com). Type it into the key field — it is never saved or sent anywhere other than the Anthropic API directly from your browser.

**Security note:** Never commit your API key to a public repo. For a shared deployment, route requests through a proxy (Cloudflare Worker, Vercel Edge Function) that injects the key server-side.

---

## How it works

```
OSM Search                    Screenshot Upload
     ↓                               ↓
OSMFetcher                    ImageAnalyser (Claude API)
  → Nominatim geocode           → sends resized base64 image
  → Overpass API roads          → returns JSON road geometry
  → project to canvas pixels         ↓
     ↓                        ← both paths →
              RoadNetwork built
         (motorway or intersection)
                   ↓
          Simulation initialises
      → Vehicles spawned per road/lane
      → TrafficSignal phases (intersection)
                   ↓
          Per-frame loop (30fps)
      → signal.step() — advance phase
      → vehicle.step() — state machine
      → Renderer draws roads + heatmap + vehicles
      → MetricsTracker records stats
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
├── style.css       — Light theme styling
├── sim.js          — Simulation engine, OSM fetcher, AI analyser, app controller
└── README.md
```

---

## Tech stack

- **Vanilla JS** — no frameworks, no build step
- **Canvas 2D API** — all rendering
- **OpenStreetMap / Overpass API** — free road geometry data
- **Nominatim** — free geocoding
- **Claude claude-sonnet-4-20250514** — optional AI image analysis
- **GitHub Pages** — hosting

---

## Licence

MIT — use freely, attribution appreciated.
