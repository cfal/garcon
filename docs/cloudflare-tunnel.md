# Connect your own domain with Cloudflare Tunnel

Use a URL such as `https://garcon.example.com` from your phone or another computer. Cloudflare Tunnel connects outward from the machine running Garcon: no router port forwarding, public IP address, or inbound firewall rule is needed. HTTPS and browser WebSockets work through the tunnel.

Garcon and `cloudflared` must both stay running. The wizard can keep **the tunnel** running at login; use the README's [Keep It Running](../README.md#keep-it-running) recipe for **Garcon itself**. Your computer must be awake and connected to the internet.

## Guided setup

1. Add your domain to [Cloudflare DNS](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/). Pick an unused subdomain such as `garcon.example.com`.
2. [Install cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) on the same machine as Garcon. On macOS use `brew install cloudflared`; on Windows use `winget install --id Cloudflare.cloudflared --exact` and reopen your terminal. On Linux use Cloudflare's linked package instructions. Confirm `cloudflared --version` works.
3. Start Garcon locally with authentication enabled. Open `http://127.0.0.1:8080/setup` and create your account before connecting the domain. If you use a different port, give that local URL to the wizard.
4. In a second terminal, from the Garcon repository, run:

   ```bash
   bun run setup:tunnel
   ```

   Enter your hostname, authorize Cloudflare in the browser, and accept background startup if wanted. `bun run setup` also offers this wizard in an interactive terminal. Its default is **No**; CI and redirected input skip the prompt.
5. Open your HTTPS URL once the tunnel connects and sign in with your Garcon account. Keep authentication enabled on every future Garcon start. The wizard checks authentication before creating DNS, but cannot stop a later manual launch with `--disable-auth`.

Run the wizard as your normal user. It uses the absolute path of `cloudflared` found in your terminal. It does not install software, change Garcon's startup options, migrate state, or replace existing DNS records. A domain must already be on Cloudflare; the wizard does not purchase domains or change nameservers.

If you pin Garcon's config directory, use the same setting here:

```bash
bun run setup:tunnel --config-dir /absolute/path/to/garcon-config
```

`GARCON_CONFIG_DIR` also works. Tunnel files live in `<config>/cloudflare/`: `credentials.json`, `config.yml`, and, where needed, the background runner and log. Treat the credentials as secrets. Cloudflare's separate account certificate from `cloudflared tunnel login` stays in its normal user directory; do not print it or commit it. On Unix, generated files are private to your user; on Windows, keep the config folder in your private user profile with user-only permissions.

Setup reuses its credentials after partial failures. Rerun with the same hostname, origin, and config directory to resume. A conflicting DNS record or a changed existing configuration stops setup instead of overwriting it. Review the conflict before changing anything. To change the local port later, stop the tunnel, update its `config.yml` service URL, validate it, and restart the tunnel.

## Background controls

These controls affect only the tunnel. Stopping Garcon remains a separate operation. Linux and macOS run `cloudflared` directly under the user service manager; Windows runs a hidden PowerShell task with a ten-second restart loop. Login is required for macOS and Windows startup. On Linux, user-service startup without login additionally requires lingering, as described in the README.

### Linux

```bash
systemctl --user status garcon-tunnel
journalctl --user -u garcon-tunnel -f
systemctl --user stop garcon-tunnel
systemctl --user start garcon-tunnel
```

Remove automatic startup:

```bash
systemctl --user disable --now garcon-tunnel
rm ~/.config/systemd/user/garcon-tunnel.service
systemctl --user daemon-reload
```

### macOS

```bash
launchctl print gui/$(id -u)/app.garcon.tunnel
tail -f ~/.garcon/cloudflare/tunnel.log
launchctl bootout gui/$(id -u)/app.garcon.tunnel
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.garcon.tunnel.plist
```

Use your selected config folder in the log path. To remove automatic startup, run the `bootout` command above, then:

```bash
rm ~/Library/LaunchAgents/app.garcon.tunnel.plist
```

### Windows (PowerShell)

```powershell
Get-ScheduledTask -TaskName GarconTunnel | Get-ScheduledTaskInfo
Get-Content "$env:USERPROFILE\.garcon\cloudflare\tunnel.log" -Tail 50 -Wait
Start-ScheduledTask -TaskName GarconTunnel
```

To stop it, stop the restart loop first, then only the connector using this configuration. Set `$tunnelConfig` to your selected config path if different:

```powershell
$tunnelConfig = "$env:USERPROFILE\.garcon\cloudflare\config.yml"
Stop-ScheduledTask -TaskName GarconTunnel
Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($tunnelConfig) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

After stopping, remove automatic startup:

```powershell
Unregister-ScheduledTask -TaskName GarconTunnel -Confirm:$false
```

### Remove the public route

After stopping and removing startup, delete **only this hostname's DNS record** in Cloudflare, then delete this tunnel using its UUID from `config.yml`:

```bash
cloudflared tunnel delete <tunnel-uuid>
```

Only after successful remote deletion, remove `<config>/cloudflare/` if no longer needed. Preserve all other Garcon state and any Cloudflare credentials or tunnels used by other applications. Nothing automatically deletes a tunnel or DNS record on setup failure.

## Docker and prebuilt servers

The interactive wizard runs from a source checkout. For a prebuilt Garcon server, install `cloudflared` separately and follow the manual setup below.

For [Garcon in Docker](docker.md), run the wizard on the host with Garcon's port published **only on loopback** (`127.0.0.1:8080:8080`). The origin is the published host URL. If `cloudflared` runs in another container, use Cloudflare's [Docker connector instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/), a shared Docker network, and Garcon's container service name as the origin; `127.0.0.1` inside that connector refers to the connector itself. The local wizard intentionally accepts only loopback origins.

## Manual setup

Cloudflare documents the underlying [locally managed tunnel flow](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/). With a running, authenticated Garcon server and `cloudflared` installed:

```bash
cloudflared tunnel login
cloudflared tunnel create garcon
```

Note the tunnel UUID and credentials path printed by Cloudflare. Create a private config file, using absolute paths:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /absolute/path/to/<tunnel-uuid>.json
ingress:
  - hostname: garcon.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

```bash
cloudflared tunnel --config /absolute/path/to/config.yml ingress validate
cloudflared tunnel route dns <tunnel-uuid> garcon.example.com
cloudflared tunnel --config /absolute/path/to/config.yml run <tunnel-uuid>
```

This last command runs in the foreground. Keep the terminal open, or configure your OS service manager to run that exact command at login with restart enabled.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Local server unavailable or account not configured | Start Garcon, finish `/setup` locally, keep authentication enabled, and rerun the wizard with the correct port. |
| DNS record already exists | Pick an unused hostname or review that record in Cloudflare. Setup never passes `--overwrite-dns`. |
| Cloudflare error 1033 | The connector is offline. Check tunnel status/logs and outbound connectivity. |
| Bad gateway / 502 | The connector cannot reach Garcon. Check the local URL, port, and whether Garcon is running. |
| Existing config or service conflict | Inspect the reported file/task. Do not delete or overwrite another application's service to continue. |

For an additional identity gate, configure [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) for your hostname. Garcon's own login remains required. Review the [security notes](security.md) before exposing your server.
