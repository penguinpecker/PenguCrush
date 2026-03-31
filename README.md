# PenguCrush

A Web3 match-3 puzzle game with an arctic/penguin theme, built with Three.js and real 3D assets.

## Tech Stack

- **Three.js** — 3D rendering with GLB assets
- **Vite** — Dev server and bundler
- **Meshy AI** — 3D tile assets (ice crystals, popsicles, fish, frosted ice)

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

## Project Structure

```
├── index.html              # Entry HTML
├── public/
│   └── assets/
│       ├── bg-arctic.png       # Arctic background
│       ├── logo.png            # PenguCrush logo
│       ├── grid-frame.glb      # 3D icy grid frame
│       ├── ice-crystal.glb     # Ice crystal tile
│       ├── popsicle.glb        # Popsicle tile
│       ├── fish.glb            # Fish tile
│       ├── frosted-ice.glb     # Frosted ice tile
│       ├── score-panel.glb     # Score HUD panel
│       └── moves-panel.glb     # Moves HUD panel
└── src/
    ├── main.js             # Game logic + Three.js renderer
    └── style.css           # Layout and styling
```

## Game Controls

- Click a tile to select it, click an adjacent tile to swap
- Match 3+ in a row/column to clear
- Score as many points as possible in 30 moves

## Roadmap

- [ ] Power-ups (bombs, row/column clears)
- [ ] Additional tile types (penguin, snowball)
- [ ] Arctic background scenery enhancements
- [ ] Web3 wallet connection (Abstract Chain)
- [ ] Onchain rewards and leaderboard

## License

MIT
