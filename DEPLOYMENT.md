# Docker deployment

This repository contains the frontend (`Chat-UI`), API (`OnChat_CoreAPI`), and shared deployment files at the repository root. Clone the repository once to get both projects and the deployment configuration.

## API container

1. Install Docker Engine with the Compose plugin on the server.
2. From the repository root, copy `.env.example` to `.env` and set real values. Generate a private JWT key (at least 32 characters) and use a SQL login dedicated to this app. Keep `.env` out of Git.
3. Configure SQL Server to listen on a fixed TCP port, enable remote TCP connections, and allow that port through the server firewall. The example connection uses `host.docker.internal,1433`; use the actual host address and port if that name does not resolve on the server.
4. Start the API from the repository root:

   ```powershell
   docker compose up -d --build
   docker compose logs -f chat-api
   ```

   The API is published on port 8080 by default. Verify `http://localhost:8080/System/Status` on the server.

5. To publish the UI, build and serve `Chat-UI` with its production API base URL left empty so it calls the same origin. Configure a reverse proxy to serve the UI and forward `/chatHub` (including WebSocket upgrades) and the API routes (`/Login`, `/Register`, `/Users`, `/Me`, `/Messages`, `/System`, and `/api`) to `http://127.0.0.1:8080`. Set `PUBLIC_ORIGIN` to the exact public UI origin, for example `https://chat.example.com`, and recreate the API container.
6. For access from outside the home/office network, point a domain at the server, configure the router's port forwarding and host firewall, and terminate HTTPS at a reverse proxy such as Caddy. Forward only HTTPS publicly; do not expose the API's plain HTTP port directly to the internet. If the ISP uses carrier-grade NAT, ordinary router port forwarding will not work; use a public tunnel or hosting provider.

## Redeploy after pulling changes

On the server, from the repository root:

```powershell
git pull
docker compose up -d --build
docker image prune -f
```

The named API service is rebuilt and restarted; the SQL database remains on the SQL Server host. Check `docker compose logs -f chat-api` after deployment. The frontend source is included under `Chat-UI`; rebuild its production assets and reload the web server after frontend changes.
