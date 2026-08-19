# FenPOS

Thermal receipt printing for shops and restaurants, where the printers are in different rooms
from each other and from the machine that talks to them.

## The two components

| | What it is | Directory | Container image |
|---|---|---|---|
| **FenPOS** | The server: public API, admin panel, authentication, and all persistent state | `fenpos/` | `ghcr.io/natroutter/fenpos` |
| **Agent** | A small Java daemon that drives the printers at one site | `agent/` | `ghcr.io/natroutter/fenpos-agent` |

An agent holds no configuration and exposes no API. It **dials out** to the server and keeps
the connection open, so a site needs no inbound port, no static address, and no firewall
change — which is what makes printers in three different buildings workable.

The server is the source of truth for everything centrally managed: agents, device
configuration, API keys and job records. An agent caches only what it needs to keep printing
through a network outage.

## Getting started

```sh
cd fenpos
pnpm install
pnpm db:migrate
pnpm dev
```

On its first start FenPOS generates an administrator password and prints it, framed, to the
log. Sign in with it and the panel asks you to choose your own before it will let you any
further — there is nothing else a session opened with the generated password can reach. The
message repeats on every start until you have, so missing it costs nothing.

Nothing is set through an unauthenticated first-run page, and there is no fixed default such as
`admin`: either would be a takeover waiting to happen on a server that is reachable before
anyone configures it. A generated secret closes that window while still asking nothing of you
beyond reading the log you just started.

Then open the panel and add an agent under **Agents**. It shows a single-use pairing code and
the address to give it.

## Pairing an agent

On the machine the printers are attached to, either run the agent and use its console:

```sh
java -jar agent/target/fenpos-agent-1.0.0.jar
pair https://fenpos.example.com AG7K-2M9P-X4TR
```

or, in Docker, set two environment variables and start it:

```yaml
environment:
  FENPOS_SERVER: https://fenpos.example.com
  FENPOS_PAIR_CODE: AG7K-2M9P-X4TR
```

Both go through the same code. The code is single-use and consumed at redemption, so leaving a
spent one in a committed `compose.yaml` leaks nothing that still works — once an identity is
stored the agent connects with that and says it ignored the variable.

`https` is required for anything but loopback: the reply to a pairing request carries the
agent's credential, and over plain HTTP anyone on the path can read it. There is no flag to
turn that off.

Once paired, add a printer under **Devices** — the port is chosen from a list the agent scans,
not typed — and print a test page from its card.

## Running in Docker

Each component has its own `Dockerfile` and `compose.yaml`. The server publishes one port for
the panel, the print API and the agent link together. **The agent publishes nothing**: it dials
out and never listens, so there is no port to open at a site and nothing to firewall.

Agents are Linux-only in Docker. Docker Desktop on Windows and macOS runs containers in a VM
with no serial passthrough, so a COM port cannot be reached from one at all — run the jar
directly on the JVM there.

Read the generated administrator password with `docker compose logs fenpos`. It is reprinted
on every start until you replace it, so a rotated or scrolled-away log is not a lockout.

Back up `fenpos/data`. It holds the agents and their credentials, every device, the API keys
and the administrator password.

## Development

```sh
cd fenpos
pnpm test        # Vitest, including tests against a real migrated SQLite database
pnpm typecheck
pnpm lint        # Biome
pnpm build
```

If the administrator password is lost, `pnpm admin:set-password "…"` sets a new one directly
against the database. It is the recovery path, not the setup path — first boot generates one.

To exercise the first-run flow more than once, `pnpm admin:reset-password` drops the
credential and every session, so the next start generates and prints a fresh password. It
leaves agents, devices, keys and history alone; only the sign-in is reset. `pnpm db:reset`
is the larger hammer — it recreates the database from the migrations and takes everything
with it.

If a page in `pnpm dev` renders but never becomes interactive — buttons dead, live values stuck
on their placeholder, and nothing in the browser console — the `.next` dev cache is stale.
`pnpm dev:clean` removes it and starts again. It is worth reaching for early, because the
failure is silent: the HTML is correct and the only symptom is that hydration never completes.

The agent needs JDK 25:

```sh
cd agent
mvn test
mvn package
```

## Design

`docs/superpowers/specs/2026-08-18-fenpos-agent-design.md` carries the architecture: the link
protocol, the pairing flow, the security model, and the reasoning behind each.
