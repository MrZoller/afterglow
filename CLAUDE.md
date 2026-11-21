# Afterglow

A control panel, scheduler and MCP server for Govee outdoor lights. A Node server (TypeScript, Express) holds the Govee key, talks to the lights and runs schedules; a React app is the interface. It is meant to run on an always-on computer at home. The lights it was built for are H61A9 neon ropes, some mounted end to end in pairs, and H7086 garden lights.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and the rules the code relies on. This file adds what a new session needs beyond that.

## Commands

- `npm run dev`: server with reload plus the web app on port 5173
- `npm run typecheck`, `npm test`, `npm run test:e2e`: all three must pass before committing (`test:e2e` builds first)
- `npm run test:e2e:all`: also runs the browser tests tagged `@slow`, which wait minutes of real time
- `npm start`: run the built app on port 4680

With no `GOVEE_API_KEY` the app runs in demo mode against `server/govee/fake.ts`: eight simulated lights, the four ropes also on a simulated local network. Use `DATA_DIR=<temp folder>` so a test run does not touch real data.

## Checking changes

- Server behaviour is covered by `test/`. Tests run the real clients against the simulators; add to the simulators rather than mocking.
- Browser behaviour is covered by `e2e/` (Playwright). Each test starts its own demo server; see "Browser tests" in CONTRIBUTING.md. For any change under `web/`, add or extend a test there and confirm the result through `app.snapshot()` as well as on the page. Look at screens with content in them, not only empty ones; `e2e/layout.spec.ts` exists for that.
- In a cloud session the browser is preinstalled and matches the pinned `@playwright/test` version. Do not run `playwright install` there, and do not change the pinned version without checking the installed browser still matches.
- Things that take real time (a cloud step of a moving look, a schedule ending, a turn-off check) are covered twice: by unit tests with injected clocks, and by `@slow` browser tests in real time.

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
