# Workspace room

The live half of APRO Works **Workspaces**: one Cloudflare Durable Object per
workspace that holds *presence* — who is connected, where their pointer is, and
which application they have open.

## Why this exists at all

Postgres is the right home for everything durable: the workspace, its roster, its
role assignments, its applications. It is the wrong home for a pointer position.
Writing a row per mouse move would be thousands of writes a second for data with
a useful lifetime of about 40 milliseconds, and reading it back would still be a
polling loop. A Durable Object is the opposite trade: state that lives in memory
on one machine, addressed by name, with a WebSocket per person and fan-out in
process.

The split matters for a second reason. **Supabase remains the only authority on
who belongs to a workspace.** This worker holds no service-role key and never
asks the database who someone is on its own behalf; it presents the *caller's own
access token* to Supabase and relays that answer. A bug here can leak cursor
positions between people who could already see each other. It cannot leak a
roster.

## Layout

| File | Holds |
| --- | --- |
| `src/index.ts` | The fetch router: `/health`, and `/workspace/:id/live` for the upgrade. Also `authorize()`. |
| `src/room.ts` | `WorkspaceRoom` — the Durable Object. Connections, cursors, liveness. |
| `src/protocol.ts` | The wire format. Mirrored at `src/lib/workspace-protocol.ts` in the app. |
| `src/env.ts` | The bindings, and nothing else. |

## Running it locally

```bash
npm install
cp .dev.vars.example .dev.vars     # fill in SUPABASE_ANON_KEY
npm run dev                        # wrangler dev, prints a local URL
```

Point `VITE_WORKSPACE_LIVE_URL` in the repository root `.env` at that URL to test
the app against a local room. Cursors fan out through the local Miniflare
instance exactly as they do in production.

## Deploying

```bash
npm run typecheck
npx wrangler secret put SUPABASE_ANON_KEY   # once, or after rotating the key
npm run deploy
```

`wrangler.jsonc` pins `account_id`, so a deploy from another machine cannot land
in the wrong account. There is no custom domain: the worker answers on
`https://apro-workspace-room.<account-subdomain>.workers.dev`, and that origin is
what `VITE_WORKSPACE_LIVE_URL` must contain.

The account subdomain can be read back from any deploy, or from
`npx wrangler deployments list`.

### Required secret

`SUPABASE_ANON_KEY` — the publishable (legacy: anon) key. It is *not*
confidential in the usual sense: it already ships inside the desktop app, because
Vite inlines it at build time. It is a secret here only so the repository config
stays reviewable without a reader having to work out which of its strings are
load-bearing. **Never put the service-role key in this worker.** It would turn a
presence service into an unfiltered database client.

`SUPABASE_URL` is a plain var, because it is genuinely public.

## Protocol

Text frames, JSON, one object per frame. The full set is in `src/protocol.ts`;
the shape of it is:

- Client → room: `{t:"cursor",x,y}`, `{t:"app",slug}`, `{t:"ping"}`
- Room → client: `{t:"welcome",you,peers}`, `{t:"join",peer}`, `{t:"leave",id}`,
  `{t:"cursor",id,x,y}`, `{t:"app",id,slug}`, `{t:"pong"}`, `{t:"error",message}`

Two conventions are deliberate and load-bearing:

- **Cursor coordinates are normalised to 0–1** against the workspace surface, not
  pixels. Two people on a 1080p and a 4K display see each other at the same place
  in the interface, which is the only interpretation that stays true when the
  windows are different sizes.
- **Colour is an index, not a value.** The palette lives in the app's
  `src/index.css` with every other colour in the product, and the index is
  derived from `user_id`, so a person draws in the same colour on every machine
  and after every reconnect. Sending hex from the server would put colours in two
  places and let them drift.

The client validates every inbound frame (`parseServerMessage`) and drops
anything it does not recognise. The deployed worker and the installed desktop app
update on completely different schedules, so a newer room must degrade to "that
message was ignored", never to a broken tab.

## What the room remembers, and for how long

| State | Lifetime | Where |
| --- | --- | --- |
| Identity (user id, email, name, role, colour, join time) | The connection, and across hibernation | `ws.serializeAttachment()` |
| Cursor position | In memory, dropped on hibernation | `#cursors` map |
| Last-seen timestamp | In memory | `#lastSeen` map |

Identity survives hibernation because the room must be able to answer "who is
here" without the client having to re-announce itself — a Durable Object that
evicts its own memory while a socket is open is invisible to the client, and
forgetting who people are would make the roster flicker.

Cursor positions deliberately do **not** survive it. A position that was current
before an eviction is a claim about where somebody's hand is right now, and it
would be wrong. A cursor that reappears where it was last seen, minutes later, is
worse than a cursor that is briefly absent.

Liveness is a 25-second client ping against a 75-second patience window, and
expiry is checked opportunistically whenever a frame arrives from anyone. There
is no timer: an idle room should cost nothing, and a room nobody is talking in
has nothing to expire that the next frame will not catch.

The client is expected to ping; the room does not ping the client. A WebSocket
that has silently died cannot be told from a quiet one, so the side that wants to
know is the side that asks.
