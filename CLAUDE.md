# Afterglow

A control panel, scheduler and MCP server for Govee outdoor lights. A Node server (TypeScript, Express) holds the Govee key, talks to the lights and runs schedules; a React app is the interface. It is meant to run on an always-on computer at home. The lights it was built for are H61A9 neon ropes, some mounted end to end in pairs, and H7086 garden lights.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and the rules the code relies on. This file adds what a new session needs beyond that.

## Commands

- `npm run dev`: server with reload plus the web app on port 5173
- `npm run typecheck`, `npm test`, `npm run build`: all three must pass before committing
- `npm start`: run the built app on port 4680

With no `GOVEE_API_KEY` the app runs in demo mode against `server/govee/fake.ts`: eight simulated lights, the four ropes also on a simulated local network. Use `DATA_DIR=<temp folder>` so a test run does not touch real data.

## Checking changes

- Server behaviour is covered by `test/`. Tests run the real clients against the simulators; add to the simulators rather than mocking.
- The repository has no browser tests. For any change under `web/`, build, start the server in demo mode with a temporary `DATA_DIR`, and drive the page in a real browser at 390 px and 1280 px wide: click through the flow you changed and confirm the result through `/api/snapshot`. Look at screens with content in them, not only empty ones.
- Things that take real time (a moving look's next step, a schedule ending, a turn-off check) need a real-time run; the unit tests cover them with injected clocks.

## Things that have gone wrong before

- A dynamic value used as a bare CSS class collided with layout classes (`app`, `scene`), blowing elements up to full height. Prefix modifier classes.
- A checkbox bound straight to server state flicked back until the server confirmed. Controls that save on change keep their own state and sync from the server.
- A test looked for the word "watches" and matched "swatches". Match quoted keys, not substrings.
- Help text and README are written from simulated behaviour. When real-hardware behaviour differs, fix the text as well as the code.

## Not yet confirmed on real lights

See "Known gaps" in [CHANGELOG.md](CHANGELOG.md). When the owner reports how something behaves on the real lights, update that list.

## Working with the owner

- On 2026-11-21 the owner asked for finished, tested work to be committed straight to `main` and pushed, without asking first. Say what went in.
- Report plainly what was tested and what was not. Much of this app could only be tested against simulators, and the owner relies on knowing which parts those are.
- User-visible changes get a line in `CHANGELOG.md` under "Unreleased", and the Help page (`web/src/help.ts`) and README are kept in step.
