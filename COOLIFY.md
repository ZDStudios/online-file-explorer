# Running the Orbit relay on Coolify

[Coolify](https://coolify.io) runs the relay on your own always-on server, so
there are **no cold starts** like the Render free tier — connections are instant
and stay warm. The relay is the same code; only where it's hosted changes.

## Prerequisites

- A server with Coolify installed (a cheap VPS is plenty — the relay only
  forwards messages and uses almost no CPU/RAM).
- A domain or subdomain you can point at that server (e.g. `orbit.yourdomain.com`).

## Deploy (Dockerfile build pack)

1. **New Resource** → **Public Repository** (or connect GitHub) →
   repo `https://github.com/ZDStudios/online-file-explorer`.
2. **Build Pack:** `Dockerfile`.
3. **Base Directory:** `/server`  (the Dockerfile lives at `server/Dockerfile`).
4. **Port:** set the exposed port to **3000**.
5. **Environment variables** → add:
   - `AUTH_TOKEN` = `Orbit123!`  (the password; use whatever you like)
   - `PORT` = `3000`
6. **Domains:** assign your domain (e.g. `https://orbit.yourdomain.com`). Coolify
   issues a Let's Encrypt certificate automatically, and its Traefik proxy passes
   WebSocket upgrades straight through — no extra config needed.
7. **Deploy.**

Check it: open `https://orbit.yourdomain.com/health` — you should see
`{"ok":true,...}`.

> Prefer Compose? Use **Build Pack: Docker Compose** with Base Directory `/server`
> (`server/docker-compose.yaml`) and set `AUTH_TOKEN` in the Environment tab.

## Point Orbit at your Coolify relay

- **Web client:** open the site → **⚙ Settings** → set **Server URL** to
  `https://orbit.yourdomain.com` → **Save & reconnect**. (Or change
  `DEFAULT_RELAY` in `docs/app.js` to make it the default for everyone.)
- **Agent:** run the consumer `orbit-agent.exe` and enter the new relay URL when
  prompted, or bake it into a custom auto build by editing the `AUTO.relay` value
  at the top of `agent/build.js` and rebuilding (`npm run build`).

That's it — same features, same password model, just faster and always on.

## Why it's faster

- **No sleeping.** Render's free tier spins down after inactivity and takes
  30–60s to wake. Coolify keeps the relay running 24/7.
- **Your hardware, your region.** Put the server near you for a shorter round trip.
- **No shared throttling.** Dedicated resources instead of a shared free tier.
