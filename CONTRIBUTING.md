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
npm run test:e2e
```

All three must pass. `npm test` runs the server tests and takes about a minute, because several of them wait on real timers. `npm run test:e2e` builds the app and runs the browser tests; the first time, install the browser it uses:

```bash
npx playwright install chromium
```

CI runs the same checks on every push to `main` and on pull requests.

## Browser tests

The tests in `e2e/` drive the real page in a real browser. Each test starts its own copy of the built app in demo mode on a free port, with its own temporary data folder, so tests are independent and run side by side. That copy ignores any `.env` in the project, so a test run cannot reach real lights, real data or real backups.

- `e2e/fixtures.ts` provides `app`, a small client for checking what the server ended up with (`app.snapshot()`, `app.light(name)`, `app.colors(name)`), and helpers for navigating and dragging.
- `app.simulate(name, { offline, ignoring })` makes a simulated light drop off the network or stop obeying, through a route that only exists in demo mode. `app.restart(edit)` stops the app and starts it again on the same data, as after a power cut.
- The checks that follow a schedule come 1, 3, 10, 30 and 60 minutes after it. Setting `AFTERGLOW_CHECK_SCALE` in a test's `appEnv` shrinks those waits (0.02 makes a minute about a second); it exists only for these tests.
- A light is not re-read from Govee for five seconds after the app changes it, so a test that wants a fresh reading (`POST /rescan`) should not have just sent that light a command.
- Check outcomes through `app` as well as on the page: a control that looks right but sent nothing is the failure these tests exist to catch.
- Wait for things with `expect.poll` or a web-first `expect`, not a fixed pause.
- Tests that wait on real time, such as a schedule ending, are tagged `@slow` in their title and only run with:

```bash
npm run test:e2e:all
```

- `e2e/layout.spec.ts` fills the app with content and checks sizes at phone and desktop width. Two styling bugs so far only showed up once a screen had real content, so when you add a list or a label, make sure that test puts something in it.

## How the code is laid out

| Path | What it holds |
| --- | --- |
| `shared/` | Types, colour maths and look rendering used by both the server and the web app |
| `server/hub.ts` | The lights, their last known state, and turning an action into commands |
| `server/queue.ts` | Per-light pacing and retries for cloud commands |
| `server/govee/cloud.ts`, `lan.ts` | Clients for Govee's cloud API and local network API |
| `server/govee/fake.ts`, `fake-lan.ts` | Simulators for both, used by demo mode and the tests |
| `server/animator.ts` | Steps moving looks |
| `server/scheduler.ts`, `verify.ts` | Schedules, carrying out missed runs, and checking that lights did what a schedule asked |
| `server/notify.ts` | Phone notifications |
| `server/backup.ts` | Backups and restore |
| `server/ops.ts` | Validation and saving of looks, zones, schedules and settings |
| `server/http.ts`, `mcp.ts` | The REST API and the MCP tools |
| `web/src/views/` | One file per screen |
| `web/src/help.ts` | The text of the Help page |
| `test/` | Server tests, run with Node's built-in test runner |
| `e2e/` | Browser tests, run with Playwright |

## Rules the code relies on

- **Every change to a light goes through `hub.apply`.** It works out each light's share of a design, updates state, ends movement and schedule follow-ups where it should, and writes the activity log. Do not call the Govee clients from anywhere else. To bring one light of several into line, pass all the targets with `only`, so the light keeps its share.
- **Cloud commands go through the queue.** Govee limits requests per light and per day. Each distinct colour on a light is one request, so anything that repeats (movement, retries) must have a budget. Local-network commands skip the pacing.
- **Validate at the edge.** Input from the REST API and the MCP tools is parsed with the zod schemas in `server/ops.ts`. Code past that point can trust its data.
- **New saved data needs a default and a place in backups.** Add the field to `empty()` in `server/store.ts` so older data files still load, and to the document in `server/backup.ts` if the user created it.
- **Teach the simulators first.** When you use a new part of a Govee API, add it to the matching simulator and test against that. Behaviour that could not be checked on real lights goes under "Known gaps" in the changelog.
- **Do not use a variable as a bare CSS class.** There is one stylesheet, and names such as `app`, `scene` and `schedule` are already taken by layout rules. Prefix modifier classes (`by-app`, not `app`).
- **Wording.** The app uses British spelling ("colour") and plain language, and names things the way the screens do. User-visible changes need a line in [CHANGELOG.md](CHANGELOG.md), and usually an update to the Help page and README.

## Commits

Write the summary as an instruction ("Add backups", "Fix activity labels"), and use the body to say why the change was needed and anything a reader could not work out from the diff.

Never commit `.env`, `data/` or anything containing a Govee key, passphrase or location.
