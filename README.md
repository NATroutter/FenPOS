<div align="center">

# FenPOS

**Thermal receipt printing for shops and restaurants, where the printers are in different
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

The agent **dials out** and holds the connection open, so a site needs no inbound port, no
static address and no firewall change. An agent also has nothing listening, so there is no
port to scan and no endpoint to attack.

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

The server validates each request and compiles it before it reaches an agent, so bad input
comes back as a `400` naming the line, column and character at fault rather than failing at
the printer.

---

## Quick start

> **Docker is the supported way to run FenPOS.** The `pnpm` and `mvn` commands further down
> are only for working on FenPOS itself.

> [!IMPORTANT]
> **`BETTER_AUTH_SECRET` is required and has no default.** Both compose files below read it from
> your environment and refuse to start without it. `docker compose` fails immediately with a
> message telling you what to set, rather than crash-looping the container. Generate one and
> export it before the first `up`:
> ```sh
> export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
> ```
> Or put `BETTER_AUTH_SECRET=...` in a `.env` file next to the compose file you're using. Docker
> Compose loads that automatically. Either way, never commit the real value. See
> [Configuration](#configuration).

### 1 · Server only

The common case: one server somewhere central, agents added later at each site.

**[`compose.server.yaml`](compose.server.yaml)**

The container runs as uid 10001 and the data directory is a bind mount, so it keeps whatever
owner the host gives it. Create it and hand it over first, or the server cannot open its
database:

```sh
mkdir -p data && chmod 700 data && sudo chown -R 10001:10001 data
```

```sh
docker compose -f compose.server.yaml up -d
docker compose -f compose.server.yaml logs fenpos   # the setup key is in here
```

Put it behind TLS. Agents refuse plain HTTP to anything but loopback.

### 2 · Agent only

At each site, on the machine the printers are plugged into. Generate a pairing code first in
the panel under **Agents**.

**[`compose.agent.yaml`](compose.agent.yaml)**: set `FENPOS_SERVER` and `FENPOS_PAIR_CODE`, and
map your printer under `devices:`.

The container runs as uid 10001 and its directories are bind mounts, so they keep whatever
owner the host gives them. Create them and hand them over first, or the agent cannot open its
store and refuses to start:

```sh
mkdir -p data logs && chmod 700 data logs && sudo chown -R 10001:10001 data logs
```

```sh
docker compose -f compose.agent.yaml up -d
```

> [!NOTE]
> On a Raspberry Pi, Docker warns that it discarded `mem_limit`. Raspberry Pi OS ships with
> the cgroup memory controller off. The agent still runs, just uncapped. To enforce the
> limit, append `cgroup_enable=memory cgroup_memory=1` to the single line in
> `/boot/firmware/cmdline.txt` and reboot.

> [!IMPORTANT]
> **Agents are Linux-only in Docker.** Docker Desktop on Windows and macOS runs containers
> inside a VM with no serial passthrough, so a COM port cannot be reached from a container at
> all. Run the jar directly on the JVM there.

### 3 · Both on one machine

A single-box install: one shop, printers attached to the same machine that runs the server.

The agent shares the server's network namespace so it can dial `127.0.0.1`. Plain HTTP is
accepted only to loopback, so `http://fenpos:3000` over a Docker network would be refused. If
you have a domain and a certificate, drop `network_mode` and point `FENPOS_SERVER` at your
`https://` address instead.

**[`compose.all-in-one.yaml`](compose.all-in-one.yaml)**

```sh
docker compose -f compose.all-in-one.yaml up -d fenpos      # server first
docker compose -f compose.all-in-one.yaml logs fenpos      # read the setup key, make a code
docker compose -f compose.all-in-one.yaml up -d            # then the agent
```

---

## First sign-in

On its first start, before any account exists, FenPOS mints a **setup key** and prints it,
framed, to the log:

```
──────────────────────────────────────────────────────────────────
  This install has no accounts yet. Claim it with this setup key:

      9MYX-5861-NGAF-JQWJ-HJ3D

  Open the panel, enter the key, and create the first account. A new key
  is issued on every restart until you do, and this message then stops.
──────────────────────────────────────────────────────────────────
```

```sh
docker compose logs fenpos
```

Open the panel (a fresh install redirects `/` straight to `/setup`), enter the key, and fill
in the name, email and password for the first account. Submitting signs you straight in and
lands you on the dashboard.

**The key is reissued on every restart** until the install is claimed, and this is deliberate:
nothing is bound to it, so replacing it costs nothing. An operator who scrolled past the log or
restarted before claiming just restarts again for a fresh key, and a key someone else glimpsed
stops working at the same moment. Only the current key's hash is stored, never the plaintext,
so there is nothing to reprint later the way the password this replaces had to be.

**Anyone who can read the log can claim the install**, for exactly as long as it is unclaimed.
That is what makes reading the log the way to get the key, and it cuts both ways: a shipped log
stream, a shared terminal, or a CI job that captures container output all carry it. Claim a new
install promptly, and treat its first boot log as a credential until you have. Once an account
exists nothing further is printed and the window is closed.

**Setup cannot be reopened once an account exists.** `/setup` then redirects to `/login`, and no
key is minted or printed on later starts. The recovery path is `pnpm auth:recover`, run on the host
with access to the data volume. It resets a named account's password, clears its two-factor
enrolment, lifts a lockout, or empties the address allowlist, writing an audit row for whichever it
did and leaving agents, devices, keys and history alone. In development, `pnpm db:reset` recreates
the database from its migrations (see
**Development** below) and setup runs again, but that discards everything else too, not just
the account.

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

Both take the same path through the agent. Once an identity is stored the agent uses it and
logs that it ignored the variable, so a spent code left in a committed `compose.yaml` is
harmless, since codes are single-use and consumed when redeemed.

> [!NOTE]
> `https` is required for anything but loopback. The reply to a pairing request carries the
> agent's credential, and over plain HTTP anyone on the path can read it. There is no flag to
> turn this off.

Once paired, add a printer under **Devices** (the serial port is chosen from a list the agent
scans, not typed) and print a test page from its card.

---

## Printing

Create a key under **API keys**, granting it the devices and permissions it needs. Keys are
hashed at rest and shown once.

```sh
curl -X POST https://fenpos.example.com/api/v1/print/kitchen/receipt-printer \
  -H "Authorization: Bearer fpk_QYm3xR7tK2vN8pLd..." \
  -H "Content-Type: application/json" \
  -d '{
        "data": [
          "<align=center><size=2>KAHVILA</size></align>",
          "<hr>",
          "Espresso<fill>2.50",
          "Croissant<fill>3.20",
          "<hr>",
          "<bold>Total<fill>5.70</bold>",
          "<feed=3><cut>"
        ],
        "linefeed": "LF"
      }'
```

```json
{ "jobId": "7cbe4cc3", "status": "QUEUED", "device": "receipt-printer", "lines": 7 }
```

The status is `202`: the job is queued, and the paper has not moved yet.

`<fill>` pads to the paper's width, so the amounts sit at the right margin on a 42-column and a
32-column printer alike, which hand-counted spaces cannot do.

**Markup:** `bold` · `underline` · `invert` · `size` · `font` · `align` · `wrap` · `nowrap` ·
`fill` · `hr` · `qr` · `barcode` · `pdf417` · `image` · `drawer` · `feed` · `cut`

**Permissions:** `print` · `jobs:read` · `jobs:cancel` · `devices:read` · `devices:control` ·
`status:read` · `assets:read` · `assets:write` · `devices:raw`

A key without a grant for the device gets `404` rather than `403`, so the endpoint does not
confirm that a device exists to someone who cannot use it. Raw ESC/POS writes need `devices:raw`
**and** the install's `Allow raw API writes` setting, which ships off. The permission alone grants
nothing until an administrator turns it on.

The **Docs** tab carries the full reference, generated from the running install.

---

## Configuration

### Server

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `file:/app/data/fenpos.db` | SQLite file. Must point at a mounted volume. |
| `BETTER_AUTH_SECRET` | none **(required)** | Signs session cookies and tokens. No default and no generated fallback: the server refuses to start without it, and the bundled compose files refuse even earlier, at `docker compose up`, before a container is created. Generate one with `openssl rand -base64 32` and keep it stable: changing it invalidates every existing session and signs everyone out at once. |
| `BETTER_AUTH_URL` | derived from the request | Absolute origin the panel is reached on, e.g. `https://pos.example.com`. Only needed behind a proxy that rewrites the host. A wrong value makes sign-in silently fail to set its cookie. |
| `PORT` | `3000` | Panel, print API and agent link share it. |
| `FENPOS_HOST` | `0.0.0.0` | Interface to bind. Rarely changed. |
| `TZ` | UTC | Job and log timestamps are user-facing. |

### Agent

| Variable | Default | What it does |
|---|---|---|
| `FENPOS_SERVER` | none | Server address. `https` unless loopback. |
| `FENPOS_PAIR_CODE` | none | Single-use pairing code. Read only when no identity is stored. |
| `TZ` | UTC | Job timestamps are user-facing. |
| `FENPOS_DEBUG` | false | Verbose logging: a stack trace on every error, each link attempt and frame, and each HTTP request with the status it got. For when the log says what failed but not why. |

Everything else (the public address, limits, retention, per-printer settings) lives in the
panel under **Settings** and **Devices**, not in environment variables. The public address
agents dial is under **Settings → General**: leave it empty to derive the address from the
request that reached the panel, or set it explicitly when the panel is reached on a different
address than agents should use.

---

## Backups and upgrades

Back up the server's `data/` volume. It holds the agents and their credentials, every device,
the API keys and the hashed account credential. `BETTER_AUTH_SECRET` lives outside it, in your
own environment configuration, not in the volume. Back it up too, since a lost or changed
secret signs every session out at once even though the account itself is unaffected (the
password hash does not depend on it). The agent's `data/` holds only its identity. If you lose
it, unpair and pair again with a fresh code.

Upgrades apply their own migrations at container start:

```sh
docker compose pull && docker compose up -d
```

Images are tagged `latest`, the exact version, and `major.minor`, so you can pin as loosely
or as tightly as you want.

If **Settings → Print limits → Printed lines per job** was ever set above 1000, an upgrade past
this release silently reverts it to its default: the setting's cap now derives from the same bound
the dispatch frame enforces, and a stored value above the new cap is treated the same as any other
out-of-range value, ignored rather than clamped. Check that setting after upgrading if you had
raised it.

---

## Security

- **Agents have no inbound surface.** They dial out and never listen, so there is no port to
  scan and no endpoint to post to.
- **Strict TLS.** The agent validates the server's certificate against the system trust
  store, and there is no "trust all certificates" option in any form. There is no certificate
  pinning: an agent accepts any certificate a CA in its trust store has issued for the
  server's name, so a TLS-inspecting proxy on the path can read and alter the link.
- **Pairing codes** are single-use, consumed atomically at redemption, expire in 15 minutes,
  and are rate-limited per address.
- **Sessions** are database-backed and revocable, 12 hours, HttpOnly. Sign-in is limited to
  five attempts per minute per address, and an account locks after ten consecutive failures.
- **The caller's address is the connection, not a header.** Everything keyed on an address — the
  sign-in limit above, the pairing limit, the optional address allowlist, every audit row — uses the
  peer that opened the connection. A forwarding header such as `X-Forwarded-For` is read only from
  the addresses listed under **Settings → Security → Trusted proxies**, which is empty by default.
  Behind a reverse proxy, put its address there, or every visitor arriving through it is counted and
  recorded as the proxy. The Settings page shows what your own request resolved to.
- **The agent validates what the server sends it.** Every frame is bounds-checked, unknown
  frames are refused without dropping the connection, and job dispatch is deduplicated by id
  for the last 10,000 ids, which is far longer than any retry a dropped link can produce.
- **Passwords** are argon2id, minimum 12 characters. Any character is accepted, including
  spaces, so passphrases work.

---

## Development

> You do not need any of this to run FenPOS. It is for working on FenPOS itself.

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
| `pnpm auth:recover` | Acts on an account from the host, outside the panel, for when nobody can sign in. `--list` names the accounts, `--reset-password <email>` replaces a credential, `--clear-2fa <email>` drops an enrolment, `--unlock <email>` lifts a lockout, and `--clear-allowlist` empties the address allowlist. One command at a time, each writing an audit row. |
| `pnpm db:reset` | Recreates the database from the migrations. Takes everything with it, including the account. The next start mints a fresh setup key and first-run setup runs again. Useful for re-testing that flow, but it is the heavy option: `auth:recover` above is what fixes a locked-out install without discarding agents, devices, keys and history. |
| `pnpm agent:bundle-logo` | Re-dithers `public/fenpos-logo.png` at each paper width the agent bundles and writes the rasters into `agent/src/main/resources/bundled/`. The output is committed, so the agent builds with Maven alone. Run this only after changing the logo or the widths, and commit what it produces. |
| `pnpm dev:clean` | Clears the `.next` dev cache and restarts. |

If a page in `pnpm dev` renders but never becomes interactive (dead buttons, live values stuck
on their placeholder, nothing in the browser console) that cache is stale. Nothing is logged
when this happens, so try `dev:clean` early.

</details>

---

## License

[MIT](agent/LICENSE) © NATroutter
