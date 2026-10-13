# Chat Anytime

Chat Anytime is a web chat app with a React frontend, an ASP.NET Core API, and a SQL Server database. The repository root (`D:\WORKSPACE\Chat_Anytime`) contains the Docker Compose deployment for both app services.

## What we changed in this chat

The mobile chat page now fits the phone's visible screen without scrolling the whole page. The conversation list and message history scroll inside their own areas. The sign-in page can still scroll when a small display or the on-screen keyboard needs more room. Safe-area padding is included for phones with a notch or home indicator.

This change is in:

- `Chat-UI/src/pages/Chat.tsx` adds and removes a chat-only viewport class while the chat screen is mounted.
- `Chat-UI/src/styles.css` locks the chat page to the viewport and keeps scrolling inside the conversation list and message history.
- `Chat-UI/index.html` enables safe-area layout on supported phones.

The frontend production build completed successfully after the change.

## How the deployed app is arranged

- `Chat-UI/` contains the React frontend.
- `OnChat_CoreAPI/` contains the ASP.NET Core API.
- `deployment/frontend.Dockerfile` builds the frontend image.
- `deployment/nginx.conf` serves the frontend and forwards API and SignalR requests to the API container.
- `Dockerfile` builds and runs the API image.
- `compose.yaml` starts the `chat-web` and `chat-api` containers together.
- `.env` contains local database credentials and application secrets. It is ignored by Git; keep it private and do not paste it into messages.
- `.env.example` lists the variables needed to create `.env`.

The browser connects to the web service on port `8090`. Nginx forwards API and live chat traffic internally to the API. The API connects to SQL Server on the Windows host via `host.docker.internal` and port `1433`. Compose binds the web and API ports to `127.0.0.1`, so they are not directly exposed on the network. Tailscale Funnel, when enabled, publishes the web service over HTTPS.

## Start it after restarting the PC

The project is in `D:\WORKSPACE\Chat_Anytime`. Docker Desktop and Tailscale must be running, and SQL Server must be started and listening on TCP port `1433`.

Compose uses `restart: unless-stopped` for both containers. Once Docker Desktop has started, Docker normally restarts the containers automatically. To start or recover the app manually, open PowerShell and run:

```powershell
cd D:\WORKSPACE\Chat_Anytime
docker compose up -d
```

Then check that both services are running:

```powershell
docker compose ps
```

Open the app on the hosting PC at <http://localhost:8090>. For public HTTPS access, check Funnel:

```powershell
tailscale funnel status
```

If Funnel is off, start it and check the status again:

```powershell
tailscale funnel --bg 8090
tailscale funnel status
```

Use the `https://...ts.net` address shown by Tailscale on other devices. The PC, Docker Desktop, SQL Server, and Tailscale need to stay running for the app to remain available. Funnel makes the website reachable from the internet; app accounts still require login.

## Build or update after changing code

Run these commands from the repository root when you want to rebuild the images, such as after pulling new code or changing the frontend/API:

```powershell
cd D:\WORKSPACE\Chat_Anytime
docker compose up -d --build
docker compose ps
```

To inspect startup errors:

```powershell
docker compose logs --tail=100 chat-api
docker compose logs --tail=100 chat-web
```

To follow API logs while it starts:

```powershell
docker compose logs -f chat-api
```

## Stop and start the app

Stop the app containers but keep the configuration and database:

```powershell
cd D:\WORKSPACE\Chat_Anytime
docker compose down
```

Start them again later with `docker compose up -d`. To stop public access while leaving the local app running, turn off Funnel:

```powershell
tailscale funnel reset
```

Do not use `docker compose down -v` unless you intentionally want to remove Docker volumes. Back up SQL Server data separately.

## Before turning off the PC

The app will be unavailable to other devices while this PC is off. Before a planned shutdown:

1. Tell anyone using the app that it will go offline and ask them to finish sending messages.
2. Turn off public access so the site is not advertised while the host is unavailable:

   ```powershell
   tailscale funnel reset
   ```

3. Stop the app containers cleanly from the repository root:

   ```powershell
   cd D:\WORKSPACE\Chat_Anytime
    docker compose down
   docker compose ps
   ```

   `docker compose ps` should show no running project containers. This stops the web and API services; it does not delete the SQL Server database or `.env` file.

4. Shut down Windows using **Start > Power > Shut down**. Avoid holding the power button or cutting power while Docker or SQL Server is writing data.

Keep regular SQL Server backups in a protected location separate from this PC. Back up before upgrades or database changes, and never use `docker compose down -v` as a shutdown command. If unexpected power loss is a concern, use a UPS for the PC and storage device.

When the PC is on again, start Docker Desktop and SQL Server, then follow [Start it after restarting the PC](#start-it-after-restarting-the-pc). Turn Funnel back on only when you want the app publicly reachable.

## Deployment configuration

Deployment prerequisites and detailed setup steps are in [`DEPLOYMENT.md`](DEPLOYMENT.md). If `.env` has not been created on this PC, create it from the example and fill in the required SQL login, random JWT key, admin email, and exact public HTTPS origin:

```powershell
cd D:\WORKSPACE\Chat_Anytime
Copy-Item .env.example .env
notepad .env
```

Do not overwrite an existing `.env` when restarting the system. Keep the SQL Server port private; only the web service should be published through Funnel.
