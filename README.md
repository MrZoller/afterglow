# Afterglow

A friendly control panel for Govee outdoor lights. It runs on a computer at home (a Mac mini is ideal) and gives you:

- **One page for everything**, on phone and desktop: on/off, brightness, colour, white, per-segment painting.
- **Govee scenes**: built-in scenes, plus the DIY scenes and snapshots you made in the Govee app.
- **Looks**: your own colour designs (a palette plus a pattern), built from a colour picker or a photo.
- **Slow movement**: any look can drift through its colours over minutes or hours, with no fast effects.
- **Describe a look** (optional): type what you want, such as "cosy autumn evening", and get designs to preview, adjust and save.
- **Zones**: named groups of lights such as "Front yard". Lights mounted end to end can be joined so they behave as one long light.
- **Schedules**: clock or sunrise/sunset times with offsets, days of the week, an optional turn-off time, and yearly date ranges for seasonal lighting.
- **Schedules that are followed up**: every start and turn-off is checked and repeated for any light that missed it, missed schedules are caught up, and your phone can be told when a light is still on.
- **AI agent access**: a built-in MCP server so an assistant such as Claude can control the lights.

Without an API key it runs in **demo mode** with eight simulated lights, so you can try it first.

The app has a built-in **Help** page: searchable answers on every feature, troubleshooting, and a list of anything this install still needs set up.

## Set up

You need [Node.js](https://nodejs.org) 22 or newer (`brew install node` on a Mac).

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Open <http://localhost:4680>. You will see the simulated lights.

### Connect your own lights

1. In the Govee Home app: **Profile → Settings → Apply for API Key**. The key arrives by email.
2. Copy `.env.example` to `.env` and paste the key after `GOVEE_API_KEY=`.
3. Restart Afterglow. Your lights appear on the Lights tab.
4. In **Settings**, enter your location so schedules can use sunrise and sunset.

Demo data and real data are kept in separate files, so nothing from the demo carries over.

### Turn on local control

Afterglow can talk to the lights directly over your home network as well as through Govee's cloud. Direct commands are instant, use none of your Govee request allowance, and work when the internet or Govee's service is down.

In the Govee Home app, open each light's settings and turn on **LAN Control** (it can take a few minutes to appear after the light powers up). Within a minute the light shows as "reached locally" under Settings → Lights. Nothing else needs configuring.

| Goes straight to the light | Goes through Govee's cloud |
| --- | --- |
| On/off, brightness, single colours, white | Multi-colour designs (gradients, blocks, painted) |
| Reading a light's state, every 30 seconds | Govee scenes, DIY scenes and snapshots |
| Movement steps on looks that show one colour per light | Movement steps on multi-colour looks |
| Multi-colour designs and their movement steps, on models where you have switched that on (see below) | |

#### Multi-colour designs over your network (experimental)

Designs with several colours can also go straight to the lights, using a message Govee does not document (it carries the commands the Govee app sends over Bluetooth). Where a model takes it, a design appears at once and costs no requests, and a moving look steps every few seconds whatever its pattern.

It is off until you have seen it work. Under Settings → **Designs over your own network**, press **Test** beside a model: its lights switch on and each is sent a pattern by this route only, green at its start, blue in the middle, red at its end. If that is what you see, turn on the switch for that model. If the lights do not change, leave it off.

Afterglow cannot tell whether a light acted on the message, only that the light is still answering, so the test by eye is the check. The message layout is the one two community projects use ([govee-local-api](https://github.com/Galorhallen/govee-local-api), [govee-lan-bridge](https://github.com/JinjAdmin/govee-lan-bridge)); neither has it working on the H61A9 or H7086 (one does not list them, the other lists them without segment support, which may only mean nobody has tried). A Govee firmware update could stop it working, in which case switch the model off and designs go through the cloud again.

If a light stops answering locally, its commands go through the cloud until it reappears. The Mac must be on the same network as the lights, and macOS may ask whether Node may accept incoming connections; allow it. Local control uses UDP port 4002, which only one app on the computer can hold, so it will be unavailable if another Govee integration is running there. Set `LAN=0` in `.env` to switch it off.

### Keep it running on a Mac

```bash
./scripts/install-mac.sh
```

This starts Afterglow whenever you log in and restarts it if it stops. Schedules only run on time while the Mac is on and awake (one that was missed is carried out late, when the Mac is next awake), so in **System Settings → Energy** turn on "Prevent automatic sleeping when the display is off", and enable automatic login if the Mac may reboot unattended. macOS may ask once whether Node may accept incoming connections; allow it. To undo, run `./scripts/uninstall-mac.sh`.

### Use it from your phone

Settings → **Open on another device** lists the addresses that work, with a copy button for each. The same list is printed when Afterglow starts.

- **At home:** on the same Wi-Fi, use the home-network address, for example `http://mac-mini.local:4680`.
- **Anywhere:** install [Tailscale](https://tailscale.com) on the Mac and your phone and sign both in to the same tailnet. Afterglow already listens on the Tailscale interface, so the address shown under "Anywhere, over Tailscale" (for example `http://mac-mini.tail1a2b3.ts.net:4680`) works from wherever your phone is. Nothing is exposed to the public internet, and no router ports need opening.

In Safari choose **Share → Add to Home Screen** to get an app icon.

For an `https://` address with a valid certificate (which also lets the phone share its location with the Settings page), have Tailscale front the app:

```bash
tailscale serve --bg 4680
```

Then open `https://<machine>.<tailnet>.ts.net` with no port.

### Lock it with a passphrase

Anyone on your network can open the page. To require a passphrase, set `ACCESS_TOKEN=` in `.env` and restart. The same value protects the API and the MCP endpoint.

### Get told on your phone

Afterglow can send a notification when a light is still on after a schedule, has not started, or a schedule ran late. It uses [ntfy](https://ntfy.sh), a free notification service with phone apps.

1. Install the ntfy app on your phone and subscribe to a topic. Make up a long name nobody could guess, such as `afterglow-` followed by a dozen random letters: anyone who knows the name can read what is sent to it.
2. Add `NOTIFY_URL=https://ntfy.sh/<that name>` to `.env` and restart.
3. In Settings → **Missed schedules**, press **Send a test**.

The messages name your lights and schedules and pass through ntfy's servers. To keep them on your own network, run your own ntfy server and use its address; if the topic needs a token, set `NOTIFY_TOKEN` as well. Any other service that accepts a plain `POST` with the message as its body will also work.

## Lights joined end to end

When two or more lights are mounted one after another, such as a pair of ropes along a path, put them in a zone and turn on **Joined end to end**. Looks, painting and movement then run across them as one long light instead of repeating on each. A gradient over a joined pair also needs half as many requests per rope.

1. Create a zone with the lights and switch on **Joined end to end**.
2. Put them in order, from where the run starts to where it ends.
3. Press **Save and test**. The run should light up green at its start, blue in the middle and red at its end. If one light runs the wrong way, tick **Reversed** for it; if they are in the wrong order, move them; then test again.

To make two runs mirror each other, such as either side of a walkway, start both at the same end. The joined behaviour applies whenever all of a zone's lights are included in what you are controlling (the zone itself, a bigger zone, or all lights); a single rope picked on its own shows the whole design by itself. For a "one per light" look, a joined run counts as one light.

Settings → Lights sets the order lights are listed in, which is also the order colours are handed out in, and has a **Reversed** switch for lights that are not part of a run.

## Slow movement

Turn on **Movement** in the look editor and choose how long one full loop through the palette takes, from ten minutes to four hours. What moves depends on the pattern:

- **Solid**: all the lights change colour together.
- **One per light**: each light takes on its neighbour's colour, so colours travel from light to light.
- **Gradient, Blocks, Alternating, Painted**: colours flow along each light.

Solid and One per light show each light in a single colour, so they move in the smallest steps, and with local control turned on those steps are sent straight to the lights every few seconds. The editor's preview plays the loop in a few seconds and tells you how often the lights will really update. A moving look works anywhere a look does, including schedules: "sunset to 11 PM, Drifting aurora" starts moving at sunset and stops when the lights turn off.

## Describe a look

With an Anthropic API key, the look editor gains a box where you describe what you want. It returns three designs; pick one to load it into the editor, then adjust, try it on the lights and save it like any other look. Follow-up requests such as "warmer, less purple" refine the look you are editing. Because looks are still, it also points out built-in animated Govee scenes that fit the description.

1. Create an API key in the [Claude Console](https://platform.claude.com).
2. Add it to `.env` as `ANTHROPIC_API_KEY=` and restart Afterglow.
3. Open **Looks → Describe**, or use the box at the top of any look you are editing.

Each request is a call to Claude (`claude-opus-5-5`) billed to your Anthropic account. What is sent: your description, the look being edited, how many lights and segments you have, and the names of the built-in scenes. Light names, zones and your location are not sent. Everything else in Afterglow works without a key.

## AI agents

Afterglow serves MCP at `/mcp` on every address it can be opened at: `http://localhost:4680/mcp` on the same computer, the home-network address from another machine at home, and the Tailscale address from any device on your tailnet. Settings → AI agents lists them with copy buttons. For Claude Code on the same computer:

```bash
claude mcp add --transport http afterglow http://localhost:4680/mcp
```

With a passphrase, add `--header "Authorization: Bearer <passphrase>"`. Clients that only speak stdio (such as Claude Desktop's config file) can bridge with `npx mcp-remote http://localhost:4680/mcp`.

The agent has to run somewhere that can reach the address you give it. Claude Code or Claude Desktop on a laptop that is signed in to your tailnet can use the Tailscale address. An assistant hosted in the cloud connects from its provider's servers rather than from your device, so a home-network or tailnet address is out of its reach.

Tools: `list_lights`, `control_lights`, `paint_segments`, `list_scenes`, `apply_scene`, `list_looks`, `save_look`, `apply_look`, `delete_look`, `list_schedules`, `save_schedule`, `set_schedule_enabled`, `delete_schedule`. Agents refer to lights and zones by name. Everything an agent does appears under Settings → Recent activity.

## Things worth knowing

- **Govee limits cloud requests.** Each change sent through the cloud is one request, and a design with several colours is one request per colour, per light. Commands sent locally do not count. Afterglow paces commands, retries when Govee asks it to slow down, and draws gradients in at most eight bands. Settings shows how many requests were sent today.
- **Some state is remembered, not read.** Govee reports power, brightness and a single colour, but not segment colours or the running scene. Afterglow shows what it last applied, and falls back to what Govee reports when it sees the colour change from elsewhere.
- **Movement is slow by design.** On a light reached locally, a look that shows it in one colour (Solid, One per light) moves in tiny steps every 5 to 60 seconds; so does any look on a model with designs over your network switched on. Through the cloud a moving look takes a small step every minute or so, never more than about 75 requests per light per hour, and pauses for the day if the account gets close to Govee's daily limit. It keeps going until you apply something else, hold it, or switch the lights off, and it carries on after a restart. Fast effects such as chases and flicker come from Govee's own scenes, because the API cannot send colours quickly enough.
- **DIY scenes and snapshots** are created in the Govee app. Use the reload button on the Scenes tab to pick up new ones.
- **Schedules are followed up.** After a schedule starts or switches lights off, Afterglow asks each light whether it obeyed: 1, 3, 10, 30 and 60 minutes later, stopping as soon as all have. A light that has not, or cannot be reached, is sent the same thing again each time. After a turn-off the schedule's card shows "confirmed off", or names the lights that are still on or unreachable, which are also marked on the Lights page. A light stops being checked as soon as it is seen to be right or anything else is applied to it, so turning one back on yourself is respected. Lights reached locally answer for themselves; for the rest the check relies on what Govee's cloud reports.
- **Missed schedules are caught up.** A light still not right after that hour is tried every ten minutes for up to a day, so one that returns after a power cut or a Wi-Fi drop is brought into line then, with its own share of the design. If the computer was off or asleep when a schedule was due, each light is given whatever the schedules last said it should be doing, provided that is less than 24 hours old. Lights you have used in Afterglow since are left alone. Settings → Missed schedules has a switch to turn this off.
- **Dropouts are recorded.** Settings → Lights notes how often each light has been unreachable in the last week, when and for how long. Frequent dropouts usually mean weak Wi-Fi at the light, which is also the usual reason a light misses a command.
- **Overlapping schedules**: when two start at the same minute, one limited to a time of year wins over an everyday one.
- **Backups are automatic.** Looks, zones, schedules, settings and how lights are named and arranged are copied every day into `data/backups` and kept for two weeks. Settings → Backups restores one, downloads the current setup as a file, or restores from a file (also the way to move to another computer). The setup being replaced is saved first, so a restore can be undone. Backups never contain the Govee key or passphrase. To keep the daily copies off the computer as well, set `BACKUP_DIR` in `.env` to a folder that syncs elsewhere, such as iCloud Drive.

## Project documents

- [CHANGELOG.md](CHANGELOG.md): what has changed, and what is not yet confirmed on real lights
- [CONTRIBUTING.md](CONTRIBUTING.md): how to work on the code
- [SECURITY.md](SECURITY.md): who can reach the app, what it stores and what leaves your computer

## Development

```bash
npm run dev
```

Runs the server with reload and the web app at <http://localhost:5173>.

```bash
npm test
```

Server tests, about a minute.

```bash
npm run test:e2e
```

Browser tests against the app in demo mode. The first time, run `npx playwright install chromium`. See [CONTRIBUTING.md](CONTRIBUTING.md) for more.

| Path | What it holds |
| --- | --- |
| `server/govee/cloud.ts` | Client for Govee's cloud API |
| `server/govee/lan.ts` | Client for Govee's local network API |
| `server/govee/fake.ts` | Simulated Govee service used by demo mode and the tests |
| `server/govee/fake-lan.ts` | Simulated local-network lights for demo mode and the tests |
| `server/hub.ts` | Lights, their state, and turning actions into commands |
| `server/queue.ts` | Per-light command pacing and retries |
| `server/scheduler.ts` | Schedule times, including sunrise and sunset, and carrying out missed runs |
| `server/verify.ts` | Checks that lights did what a schedule asked, and keeps trying those that did not |
| `server/notify.ts` | Phone notifications |
| `server/animator.ts` | Advances moving looks step by step |
| `server/mcp.ts` | MCP tools |
| `server/ai.ts` | Look ideas from a description, via the Claude API |
| `shared/` | Types, colour maths and look patterns used by both sides |
| `web/src/` | The React app |
| `e2e/` | Browser tests |

## Licence

[MIT](LICENSE).
