# Grow

Static fish growth game prepared for GitHub Pages.

## Run locally

```bash
npm start
```

Then open `http://localhost:3000`.

## Deploy on GitHub Pages

1. Push the repo to the `main` branch.
2. In GitHub, open `Settings` -> `Pages`.
3. Set `Build and deployment` to `GitHub Actions`.
4. The included workflow in `.github/workflows/pages.yml` will publish the site.

## Controls

- Mouse or `WASD`: swim
- `Space` or `Shift`: boost

## Notes

- The game now runs fully in the browser for better performance.
- Multiplayer on GitHub Pages works across tabs in the same browser via `BroadcastChannel`.
- Unlocks are stored in `localStorage`.
- Deployment touch-up: March 13, 2026.
