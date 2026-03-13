# Grow

Real multiplayer fish growth game with room links.

## Run locally

```bash
npm start
```

Then open `http://localhost:3000`.

## Deploy

This version needs a Node host because the game state lives on the server.

- `Render`: the repo includes `render.yaml` for a basic web service setup
- `Railway` / `Fly.io` / any other Node host: run `npm start`

## Controls

- Mouse or `WASD`: swim
- `Space` or `Shift`: boost

## Notes

- Share `/?room=your-room-id` so another player joins the same ocean.
- Unlocks are stored in `localStorage`.
- GitHub Pages can still serve the static files, but real shared multiplayer requires the Node server.
