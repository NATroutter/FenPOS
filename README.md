<div align="center">

# FenPOS

**Thermal receipt printing for shops and restaurants — where the printers are in different
rooms from each other, and from the machine that talks to them.**

[![Build](https://img.shields.io/github/actions/workflow/status/NATroutter/FenPOS/images.yml?branch=master&label=build&style=for-the-badge&logo=github)](https://github.com/NATroutter/FenPOS/actions/workflows/images.yml)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](agent/LICENSE)
[![Server image](https://img.shields.io/badge/ghcr.io-fenpos-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/NATroutter/FenPOS/pkgs/container/fenpos)
[![Agent image](https://img.shields.io/badge/ghcr.io-fenpos--agent-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/NATroutter/FenPOS/pkgs/container/fenpos-agent)

[![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Java](https://img.shields.io/badge/Java-25-ED8B00?style=flat-square&logo=openjdk&logoColor=white)](https://openjdk.org)
[![SQLite](https://img.shields.io/badge/SQLite-Prisma-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://www.prisma.io)
[![ESC/POS](https://img.shields.io/badge/ESC%2FPOS-serial-555555?style=flat-square)](#printing)

</div>

---

## What it is

A restaurant has a printer at the bar, one in the kitchen and one at the counter. They are in
different rooms, sometimes different buildings, and they cannot all hang off one machine.

FenPOS splits that into a **server** you run once and an **agent** you run at each site.

|  | What it does | Image |
|---|---|---|
| **Server** | Public API, admin panel, authentication, and every piece of persistent state | `ghcr.io/natroutter/fenpos` |
| **Agent** | A small Java daemon that drives the printers physically attached to one machine | `ghcr.io/natroutter/fenpos-agent` |

The agent **dials out** and holds the connection open. A site needs no inbound port, no static
address and no firewall change — which is the entire reason printers in three buildings are
workable. It also means an agent has no network surface to attack: there is nothing listening.

```mermaid
flowchart LR
    POS["POS / till<br/><i>your software</i>"] -- "HTTPS + API key" --> S
    Browser["Admin panel"] -- HTTPS --> S
    S["<b>FenPOS server</b><br/>validates · compiles to IR<br/>SQLite"]
    S -. "WebSocket<br/><b>agent dials out</b>" .-> A1["Agent · bar"]
    S -. "WebSocket" .-> A2["Agent · kitchen"]
    A1 --> P1["🖨 serial"]
    A2 --> P2["🖨 serial"]
```

The server validates every request and compiles it to an intermediate form before it reaches
an agent, so bad input is refused **synchronously** with the exact line, column and character
at fault — not discovered later by a printer that stops mid-receipt.

---

## Quick start

> **Docker is the supported way to run FenPOS.** Everything below is all you need. The
> `pnpm` and `mvn` commands further down are for working on FenPOS itself.

Pick the arrangement that matches your site.

### 1 · Server only

The common case: one server somewhere central, agents added later at each site.

```yaml
# compose.yaml
services:
  fenpos:
    image: ghcr.io/natroutter/fenpos:latest
    container_name: fenpos
    restart: unless-stopped

    ports:
      # Panel, print API and the agent link all share this one port.
      - "3000:3000"

    volumes:
      # Everything that matters. Back this up.
      - ./data:/app/data

    environment:
      # The address agents should dial. Optional — the panel otherwise derives it from the
      # request. Set it when the panel is reached on a different address than agents use.
      PUBLIC_URL: "https://fenpos.example.com"
      TZ: "Europe/Helsinki"

    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3

    mem_limit: 1g
```

```sh
docker compose up -d
docker compose logs fenpos     # your administrator password is in here
```

Put it behind TLS. Agents refuse plain HTTP to anything but loopback, and the pairing reply
carries an agent's credential.

### 2 · Agent only

At each site, on the machine the printers are plugged into. Generate a pairing code first in
the panel under **Agents**.

```yaml
# compose.yaml
services:
  fenpos-agent:
    image: ghcr.io/natroutter/fenpos-agent:latest
    container_name: fenpos-agent
    restart: unless-stopped

    # No ports. The agent dials out and never listens — there is nothing to publish.

    devices:
      # One per printer. Find the stable name with:  ls -l /dev/serial/by-id/
      # ttyUSB numbering changes across reboots; a udev rule is worth setting up.
      - "/dev/ttyUSB0:/dev/ttyUSB0"

    group_add:
      # The container runs as a non-root user, so it needs the group owning the device.
      # Find it with:  stat -c '%g' /dev/ttyUSB0
      - "20"                      # dialout on Debian/Ubuntu

    volumes:
      # The agent's identity: server address and the credential issued at pairing.
      # Lose this and the agent is unpaired and needs a fresh code.
      - ./data:/app/data
      - ./logs:/app/logs

    environment:
      FENPOS_SERVER: "https://fenpos.example.com"
      FENPOS_PAIR_CODE: "AG7K-2M9P-X4TR"     # single-use, read only on first boot
      TZ: "Europe/Helsinki"

    mem_limit: 512m

    # Optional: enables the console via `docker attach fenpos-agent`.
    # Detach with Ctrl-P Ctrl-Q — Ctrl-C would stop the JVM.
    stdin_open: true
    tty: true
```

> [!IMPORTANT]
> **Agents are Linux-only in Docker.** Docker Desktop on Windows and macOS runs containers
> inside a VM with no serial passthrough, so a COM port cannot be reached from a container at
> all. Run the jar directly on the JVM there.

### 3 · Both on one machine

A single-box install — one shop, printers attached to the same machine that runs the server.

The agent shares the server's network namespace so it can dial `127.0.0.1`. That is
deliberate: plain HTTP is accepted **only** to loopback, so `http://fenpos:3000` across a
Docker network would be refused. If you have a domain and a certificate, drop `network_mode`
and point `FENPOS_SERVER` at your `https://` address instead.

```yaml
# compose.yaml
services:
  fenpos:
    image: ghcr.io/natroutter/fenpos:latest
    container_name: fenpos
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./server-data:/app/data
    environment:
      TZ: "Europe/Helsinki"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 3
    mem_limit: 1g

  fenpos-agent:
    image: ghcr.io/natroutter/fenpos-agent:latest
    container_name: fenpos-agent
    restart: unless-stopped

    # Shares the server's network namespace, so 127.0.0.1 reaches it and plain HTTP is
    # allowed. Requires the server to be healthy first.
    network_mode: "service:fenpos"
    depends_on:
      fenpos:
        condition: service_healthy

    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"
    group_add:
      - "20"
    volumes:
      - ./agent-data:/app/data
      - ./agent-logs:/app/logs

    environment:
      FENPOS_SERVER: "http://127.0.0.1:3000"
      FENPOS_PAIR_CODE: "AG7K-2M9P-X4TR"
      TZ: "Europe/Helsinki"

    mem_limit: 512m
    stdin_open: true
    tty: true
```

Start the server first, read the password from its log, create a pairing code in the panel,
put it in `FENPOS_PAIR_CODE`, then bring the agent up.

---

## First sign-in

On its first start FenPOS **generates an administrator password** and prints it, framed, to
the log:

```
──────────────────────────────────────────────────────────────────
  This install is still using its generated administrator password:

      9MYX-5861-NGAF-JQWJ-HJ3D

  Sign in with it. FenPOS will ask you to replace it before letting you
  into the panel, and this message stops once you have.
──────────────────────────────────────────────────────────────────
```

```sh
docker compose logs fenpos
```

Sign in with it and the panel asks you to choose your own password before it will let you any
further. **There is nothing else a session opened with the generated password can reach** —
every panel route redirects to the change-password screen until it has been replaced.

The message repeats on **every start** until you replace it, so a scrolled-away or rotated log
is never a lockout.

<details>
<summary>Why not a fixed default like <code>admin</code>, or a setup page?</summary>

Both are the same hole. A server is usually reachable before its owner gets to it, and either
approach hands the install to whoever arrives first — an unauthenticated setup page to anyone
who finds it, a published default to anyone who has read the documentation. A generated secret
closes that window while still asking nothing of you beyond reading the log you just started.

</details>

---

## Pairing an agent

In the panel, **Agents → Add agent**. It shows a single-use code and the address to give it.

**In Docker**, set two environment variables and start the container:

```yaml
environment:
  FENPOS_SERVER: https://fenpos.example.com
  FENPOS_PAIR_CODE: AG7K-2M9P-X4TR
```

**On bare metal**, use the agent's console:

```sh
java -jar fenpos-agent.jar
pair https://fenpos.example.com AG7K-2M9P-X4TR
```

Both go through the same code path. Once an identity is stored the agent connects with that
and logs that it ignored the variable, so a spent code left in a committed `compose.yaml`
leaks nothing that still works — codes are single-use and consumed at redemption, not at first
connect.

> [!NOTE]
> `https` is required for anything but loopback. The reply to a pairing request carries the
> agent's credential, and over plain HTTP anyone on the path can read it. There is no flag to
> turn this off.

Once paired, add a printer under **Devices** — the serial port is chosen from a list the agent
scans, not typed — and print a test page from its card.

---

## Printing

Create a key under **API keys**, granting it the devices and permissions it needs. Keys are
hashed at rest and shown once.

```sh
curl -X POST https://fenpos.example.com/api/print/kitchen/receipt-printer \
  -H "Authorization: Bearer fpk_QYm3xR7tK2vN8pLd..." \
  -H "Content-Type: application/json" \
  -d '{
        "data": [
          "[align=center][size=2]KAHVILA[/size][/align]",
          "[hr]",
          "Espresso           2.50",
          "Croissant          3.20",
          "[hr]",
          "[bold]Total          5.70[/bold]",
          "[feed=3][cut]"
        ],
        "wrap": true,
        "linefeed": "LF"
      }'
```

```json
{ "jobId": "7cbe4cc3", "status": "QUEUED", "device": "receipt-printer", "lines": 7 }
```

`202`, not `201` — the job is accepted and queued; the paper has not moved yet.

**Markup:** `align` · `bold` · `underline` · `invert` · `size` · `font` · `hr` · `feed` · `cut`

**Permissions:** `print` · `jobs:read` · `jobs:cancel` · `devices:read` · `devices:control` ·
`status:read`

A key without a grant for the device gets `404`, not `403` — the endpoint does not confirm
that a device it cannot reach exists. Raw ESC/POS writes are admin-session only and can never
be granted to a key.

Full reference, generated from the running install, is on the **Docs** tab.

---

## Configuration

### Server

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `file:/app/data/fenpos.db` | SQLite file. Must point at a mounted volume. |
| `PORT` | `3000` | Panel, print API and agent link share it. |
| `PUBLIC_URL` | derived from the request | The address agents should dial. Set it when the panel is reached on a different address than agents use. |
| `FENPOS_HOST` | `0.0.0.0` | Interface to bind. Rarely changed. |
| `TZ` | UTC | Job and log timestamps are user-facing. |

### Agent

| Variable | Default | What it does |
|---|---|---|
| `FENPOS_SERVER` | — | Server address. `https` unless loopback. |
| `FENPOS_PAIR_CODE` | — | Single-use pairing code. Read only when no identity is stored. |
| `TZ` | UTC | Job timestamps are user-facing. |

Everything else — limits, retention, per-printer settings — lives in the panel under
**Settings** and **Devices**, not in environment variables.

---

## Backups and upgrades

Back up the server's `data/` volume. It holds the agents and their credentials, every device,
the API keys and the administrator password. The agent's `data/` holds only its identity; if
you lose it, unpair and pair again with a fresh code.

Upgrades apply their own migrations at container start:

```sh
docker compose pull && docker compose up -d
```

Images are tagged `latest`, the exact version, and `major.minor` — pin as loosely or as
tightly as you like.

---

## Security

- **Agents have no inbound surface.** They dial out and never listen. There is no port to
  scan and no endpoint to post to.
- **Strict TLS with no escape hatch.** No "trust all certificates" flag exists, in any form.
- **SPKI pinning from pairing onward**, so a mis-issued certificate or a MITM proxy is
  refused even when the certificate chain validates.
- **Pairing codes** are single-use, consumed atomically at redemption, expire in 15 minutes,
  and are rate-limited per IP.
- **Sessions** are database-backed and revocable, 12 hours, HttpOnly. Sign-in is limited to
  five attempts per minute.
- **The agent distrusts the server**: every frame is bounds-checked, unknown frames are
  refused rather than fatal, and job dispatch is deduplicated by id.
- **Passwords** are argon2id. Any character is accepted, including spaces — a passphrase is
  the point. Minimum 12 characters.

---

## Development

> Not needed to run FenPOS. This is for working on it.

```sh
cd fenpos
pnpm install
pnpm db:migrate
pnpm dev              # http://localhost:3000
```

```sh
pnpm test             # Vitest, against a real migrated SQLite database
pnpm typecheck
pnpm lint             # Biome
pnpm build
```

The agent needs JDK 25:

```sh
cd agent
mvn test
mvn package
```

<details>
<summary>Recovery and testing helpers</summary>

| Command | What it does |
|---|---|
| `pnpm admin:set-password "…"` | Sets the password directly against the database. The recovery path for a lost password — first boot generates one, so this is not setup. |
| `pnpm admin:reset-password` | Drops the credential and every session, so the next start generates a fresh password. Leaves agents, devices, keys and history alone. Useful for re-testing the first-run flow. |
| `pnpm db:reset` | Recreates the database from the migrations. Takes everything with it. |
| `pnpm dev:clean` | Clears the `.next` dev cache and restarts. |

If a page in `pnpm dev` renders but never becomes interactive — dead buttons, live values
stuck on their placeholder, nothing in the browser console — that cache is stale. The failure
is silent, so reach for `dev:clean` early.

</details>

---

## Design

[`docs/superpowers/specs/2026-08-18-fenpos-agent-design.md`](docs/superpowers/specs/2026-08-18-fenpos-agent-design.md)
carries the architecture: the link protocol, the pairing flow, the security model, and the
reasoning behind each decision.

## License

[MIT](agent/LICENSE) © NATroutter
