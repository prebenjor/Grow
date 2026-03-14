# Grow

Real multiplayer fish growth game with room links, a WebSocket game loop, and server-owned progression.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Deploy

This version needs a Node host because both the game state and player progression live on the server.

- `Render`: use a `Web Service` or the included `render.yaml`
- `Railway` / `Fly.io` / any other Node host: run `npm start`

### Render notes

- Health check path: `/healthz`
- Build command: `npm install`
- Start command: `npm start`
- For persistent progression across redeploys, mount a persistent disk and set `DATA_DIR` to that mounted path

## Controls

- Mouse or `WASD`: swim
- `Space` or `Shift`: boost

## Notes

- Share `/?room=your-room-id` so another player joins the same ocean.
- The live game runs over WebSockets with an authoritative Node simulation.
- Pearls, variants, upgrades, and best score are stored server-side in `profiles.json` or the directory configured by `DATA_DIR`.
- On free-tier hosting, the browser cache can automatically repopulate the server profile after a restart or redeploy.
- GitHub Pages can still serve static files, but real shared multiplayer requires the Node server.
