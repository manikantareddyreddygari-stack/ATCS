# 🚦 ATCS — Adaptive Traffic Signal Control System

> **BTech CSE Major Project | JNTUH 2025–2026**  
> Real-Time CCTV Computer Vision Analytics + Emergency Vehicle Priority Preemption

## Overview

A full-stack **Adaptive Traffic Signal Control System** built with:
- **F.V. Webster's Delay Optimization** (1958) — computes optimal cycle length C₀ dynamically
- **NEMA TS-2 Dual-Ring Actuated State Machine** — Gap-Out, Min-Green, Unit Passage extensions
- **Computer Vision MOT Engine** — Multi-Object Tracking with virtual inductive loops
- **Emergency Vehicle Priority (EVP)** — Yellow → All-Red → Green Corridor preemption
- **Zero-dependency Node.js backend** — no npm packages, pure core modules
- **HTML5 Canvas TMC Console** — real-time intersection visualization + Chart.js telemetry

## Performance Results

| Metric | Fixed-Time | ATCS Adaptive | Improvement |
|--------|-----------|---------------|-------------|
| Avg Vehicle Delay | ~65 s | ~29.7 s | **↓ 54.4%** |
| Intersection Throughput | ~1400 vph | ~1800 vph | **↑ 28.6%** |
| Emergency Transit Time | 35.0 s | 3.6 s | **↓ 88.5%** |

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/ATCS.git
cd ATCS
node server.js
```

Open **http://localhost:3000** in your browser.

## Tech Stack

- **Backend**: Node.js (zero external dependencies)
- **Frontend**: HTML5 Canvas 2D, Chart.js, Inter font
- **Database**: Write-Ahead Logging (WAL) — `data/traffic_analytics.json`
- **Algorithms**: Webster (1958), NEMA TS-2, Euclidean centroid MOT

## Project Structure

```
ATCS/
├── server.js           ← Backend: Webster + NEMA state machine + REST API
├── public/
│   ├── index.html      ← TMC Web Console layout
│   ├── style.css       ← Professional dark UI design system
│   └── app.js          ← Canvas renderer + vehicle physics + API client
├── data/               ← WAL database (auto-created)
└── package.json
```

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/state` | GET | Full system state snapshot |
| `/api/flows` | POST | Update approach demand (vph) |
| `/api/emergency` | POST | Trigger EVP preemption |
| `/api/analytics` | GET | Last 100 WAL audit records |
| `/api/reset` | POST | Reset to normal operation |

## License

MIT — Academic use for BTech CSE Major Project, JNTUH 2025–2026.
