# Public deployment from a Windows PC using a free Tailscale URL

This setup builds the frontend (`Chat-UI`) and API (`OnChat_CoreAPI`) with Docker Compose. Tailscale Funnel publishes the frontend over HTTPS at a stable `*.ts.net` address, so you do not need to buy a domain or open router ports. The API port is bound only to loopback; Nginx proxies the frontend, API routes, and SignalR WebSocket traffic internally.

Tailscale Funnel is currently in beta and has non-configurable bandwidth limits. Tailscale makes Funnel available on all plans, but its free Personal plan is for non-commercial use. Confirm that the plan terms fit how you intend to use this app before making it public. [Funnel overview and requirements](https://tailscale.com/docs/features/tailscale-funnel) · [Tailscale plans](https://tailscale.com/pricing)

## Prerequisites

1. Install Docker Desktop for Windows and enable its WSL 2 backend. Configure Docker Desktop to start when you sign in. The PC and Docker Desktop must remain running for the app to be available.
2. Install Tailscale for Windows and sign in to a Tailscale account. Enable MagicDNS and HTTPS certificates for the tailnet, and enable Funnel in the admin console/policy. [Windows installation](https://tailscale.com/download/windows) · [Funnel setup](https://tailscale.com/docs/features/tailscale-funnel)
3. In SQL Server Configuration Manager, enable TCP/IP for the `SQLEXPRESS` instance, set a fixed TCP port of `1433`, and restart SQL Server. Enable mixed-mode authentication and create a dedicated SQL login that can access the app database. Docker containers cannot use your Windows integrated login for this SQL connection. Do not expose SQL Server's port on the router or to the internet. [Microsoft SQL Server port guidance](https://learn.microsoft.com/en-us/sql/tools/configuration-manager/tcp-ip-properties-ip-addresses-tab?view=sql-server-ver17)

## Configure

Find your Tailscale HTTPS name in the Tailscale admin console under **DNS** or **Machines**. It looks like `your-pc.your-tailnet.ts.net`.

From the repository root, create the private environment file:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and replace the example values:

- `CHAT_DB_CONNECTION`: `Server=host.docker.internal,1433;Database=ChatDB;User Id=<sql-login>;Password=<strong-password>;Encrypt=True;TrustServerCertificate=True;`
- `JWT_KEY`: a private random secret of at least 32 characters. Generate one in PowerShell with `[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))`.
- `ADMIN_EMAIL`: the email address that should receive the app's admin role.
- `PUBLIC_ORIGIN`: your exact Tailscale HTTPS origin, for example `https://your-pc.your-tailnet.ts.net`.

Keep `.env` private; it is ignored by Git and Docker.

## Start the app and publish it

From the repository root:

```powershell
docker compose up -d --build
docker compose logs -f chat-api
```

The UI is available on this PC at `http://localhost:8090`. The API applies its EF Core migrations at startup. In a second PowerShell window, run:

```powershell
tailscale funnel --bg 8090
tailscale funnel status
```

Use the `https://...ts.net` URL shown by Tailscale to open the app from outside your network. Anyone with that public URL can reach the app, so use strong account passwords and only share the URL with intended users. The funnel only publishes the web service; it does not make SQL Server public.

## Redeploy or stop

After code changes, from the repository root:

```powershell
git pull
docker compose up -d --build
```

Stop the app containers with `docker compose down`; disable public access with `tailscale funnel reset`. Do not run `docker compose down -v` unless you intend to remove volumes.
