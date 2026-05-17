# Public HTTP Server

A small dependency-free Node.js HTTP server that is ready to run behind a production edge such as Cloudflare Tunnel, a reverse proxy, or a container platform.

## Endpoints

- `/` - simple HTML status page
- `/health` - JSON health check
- `/api/hello?name=Jose` - JSON greeting
- `POST /messages` - public HTML form submission endpoint
- `POST /api/messages` - public JSON message submission endpoint
- `GET /api/messages` - token-protected list of recent messages

If `API_TOKEN` is set, protected API routes require:

```bash
Authorization: Bearer <API_TOKEN>
```

The public message form does not require a token.

## Run Locally

```bash
node server.js
```

Optional settings:

```bash
HOST=0.0.0.0 PORT=3000 SERVICE_NAME=public-http-server API_TOKEN=change-me node server.js
```

## Production Requirements

For production internet access, do not use an account-less `trycloudflare.com` quick tunnel. Use one of these stable options:

1. A named Cloudflare Tunnel with your own domain.
2. A VPS or cloud VM with systemd and Cloudflare Tunnel.
3. A managed container host with HTTPS at the edge.
4. A managed host's provider-owned domain if you do not own a domain yet.

Set a real `API_TOKEN` before exposing API routes.

## No Domain Option

You do not need to own a domain to run this in production. Use a managed platform that gives the service a stable HTTPS hostname:

- Render web service: `https://<service-name>.onrender.com`
- Railway generated domain: `https://<generated-name>.up.railway.app`
- Fly.io app hostname: `https://<app-name>.fly.dev`

These are production-capable URLs owned by the hosting provider. You can add your own domain later without changing the app code.

### Render

The repository root includes `render.yaml`. It uses `rootDir: public-http-server`, so Render builds and runs this folder while still finding the Blueprint at the repo root.

1. Push this project to a Git repository.
2. In Render, create a new Blueprint or Web Service from the repository.
3. Choose the root `render.yaml` when asked for a Blueprint file.
4. Set `API_TOKEN` in Render's environment settings.
5. Deploy.

Render expects web services to listen on the configured `PORT`; this template uses `10000`.

The Blueprint uses Render's `free` plan so you can deploy without paying. Free web services can spin down after inactivity; switch `plan` in the root `render.yaml` to `starter` or higher when you need always-on production behavior.

### Railway

This folder includes `railway.json` and `Dockerfile`.

1. Push this project to a Git repository.
2. Create a Railway project from the repository.
3. Add environment variables:

   ```bash
   HOST=0.0.0.0
   PORT=3000
   SERVICE_NAME=public-http-server
   API_TOKEN=replace-with-a-long-random-secret
   ```

4. In the service's Networking settings, generate a public Railway domain.

### Fly.io

This folder includes `fly.toml.example`.

1. Copy the example config:

   ```bash
   cp fly.toml.example fly.toml
   ```

2. Edit `app = "replace-with-unique-app-name"`.
3. Set the API token as a secret:

   ```bash
   fly secrets set API_TOKEN=replace-with-a-long-random-secret
   ```

4. Deploy:

   ```bash
   fly deploy
   ```

The app will be reachable at `https://<app-name>.fly.dev`.

## Option A: VPS + Cloudflare Named Tunnel

On the production host:

```bash
sudo useradd --system --home /opt/public-http-server --shell /usr/sbin/nologin public-http
sudo mkdir -p /opt/public-http-server
sudo cp server.js package.json /opt/public-http-server/
sudo chown -R public-http:public-http /opt/public-http-server
```

Create `/etc/public-http-server.env`:

```bash
HOST=127.0.0.1
PORT=3000
SERVICE_NAME=public-http-server
API_TOKEN=replace-with-a-long-random-secret
```

Install the service:

```bash
sudo cp deploy/systemd/public-http-server.service /etc/systemd/system/public-http-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now public-http-server
sudo systemctl status public-http-server
```

Create a named Cloudflare Tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create public-http-server
cloudflared tunnel route dns public-http-server your-domain.example.com
```

Copy `deploy/cloudflare/config.yml.example` to `/etc/cloudflared/config.yml`, then replace `your-domain.example.com` with your domain and set the generated credentials file path.

Install the tunnel service:

```bash
sudo cp deploy/cloudflare/cloudflared.service.example /etc/systemd/system/cloudflared-public-http-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-public-http-server
sudo systemctl status cloudflared-public-http-server
```

## Option B: Docker

Build and run:

```bash
docker build -t public-http-server .
docker run --rm -p 3000:3000 --env-file .env public-http-server
```

For production, run this behind a managed HTTPS ingress or a named Cloudflare Tunnel.

## Health Check

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "ok": true,
  "service": "public-http-server",
  "uptimeSeconds": 1,
  "timestamp": "2026-05-16T00:00:00.000Z"
}
```

## Message Submissions

External users can visit the home page and submit the form:

```text
https://public-http-server.onrender.com/
```

Submit a message with JSON:

```bash
curl -X POST "https://public-http-server.onrender.com/api/messages" \
  -H "content-type: application/json" \
  -d '{"name":"Jose","email":"jose@example.com","message":"Hello from the API"}'
```

Read recent messages with your API token:

```bash
curl "https://public-http-server.onrender.com/api/messages" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

Messages are stored in a JSONL file on the running server instance. On Render's free plan, local filesystem data is not a durable database, so use this as a lightweight inbox. For long-term production storage, add a database or email/webhook delivery.

## Stop The Current Demo Tunnel On This Mac

The temporary demo tunnel from the first setup can be stopped with:

```bash
launchctl bootout gui/$(id -u) "/Users/josegu/Documents/New project 2/launchd/com.codex.public-http-tunnel.plist"
launchctl bootout gui/$(id -u) "/Users/josegu/Documents/New project 2/launchd/com.codex.public-http-server.plist"
```
