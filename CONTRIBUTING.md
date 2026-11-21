# Contributing

How to work on Afterglow. The [README](README.md) covers installing and using it; this covers changing it.

## Getting set up

You need Node.js 22 or newer.

```bash
npm install
```

```bash
npm run dev
```

This runs the server with reload on port 4680 and the web app at <http://localhost:5173>. Without a Govee API key it starts in demo mode with eight simulated lights, four of which also answer on a simulated local network. Almost everything can be built and tested that way, with no real lights.

## Before you commit

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

All three must pass. The tests take about a minute because several of them wait on real timers.

There are no browser tests in the repository. After changing anything in `web/`, open the app and check the screens you touched at phone width (about 390 px) and desktop width, with content in them, not just in their empty state. Two styling bugs so far only showed up once a screen had real content.

## How the code is laid out

| Path | What it holds |
| --- | --- |
| `shared/` | Types, colour maths and look rendering used by both the server and the web app |
| `server/hub.ts` | The lights, their last known state, and turning an action into commands |
| `server/queue.ts` | Per-light pacing and retries for cloud commands |
| `server/govee/cloud.ts`, `lan.ts` | Clients for Govee's cloud API and local network API |
| `server/govee/fake.ts`, `fake-lan.ts` | Simulators for both, used by demo mode and the tests |
| `server/animator.ts` | Steps moving looks |
| `server/scheduler.ts`, `verify.ts` | Schedules, and checking that turn-offs happened |
| `server/backup.ts` | Backups and restore |
| `server/ops.ts` | Validation and saving of looks, zones, schedules and settings |
| `server/http.ts`, `mcp.ts` | The REST API and the MCP tools |
| `web/src/views/` | One file per screen |
| `web/src/help.ts` | The text of the Help page |
| `test/` | Tests, run with Node's built-in test runner |

## Rules the code relies on

- **Every change to a light goes through `hub.apply`.** It works out each light's share of a design, updates state, ends movement and turn-off checks where it should, and writes the activity log. Do not call the Govee clients from anywhere else.
- **Cloud commands go through the queue.** Govee limits requests per light and per day. Each distinct colour on a light is one request, so anything that repeats (movement, retries) must have a budget. Local-network commands skip the pacing.
- **Validate at the edge.** Input from the REST API and the MCP tools is parsed with the zod schemas in `server/ops.ts`. Code past that point can trust its data.
- **New saved data needs a default and a place in backups.** Add the field to `empty()` in `server/store.ts` so older data files still load, and to the document in `server/backup.ts` if the user created it.
- **Teach the simulators first.** When you use a new part of a Govee API, add it to the matching simulator and test against that. Behaviour that could not be checked on real lights goes under "Known gaps" in the changelog.
- **Do not use a variable as a bare CSS class.** There is one stylesheet, and names such as `app`, `scene` and `schedule` are already taken by layout rules. Prefix modifier classes (`by-app`, not `app`).
- **Wording.** The app uses British spelling ("colour") and plain language, and names things the way the screens do. User-visible changes need a line in [CHANGELOG.md](CHANGELOG.md), and usually an update to the Help page and README.

## Commits

Write the summary as an instruction ("Add backups", "Fix activity labels"), and use the body to say why the change was needed and anything a reader could not work out from the diff.

Never commit `.env`, `data/` or anything containing a Govee key, passphrase or location.
