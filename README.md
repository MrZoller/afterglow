# Afterglow

A friendly control panel for Govee outdoor lights. It runs on a computer at home (a Mac mini is ideal) and gives you:

- **One page for everything**, on phone and desktop: on/off, brightness, colour, white, per-segment painting.
- **Govee scenes**: built-in scenes, plus the DIY scenes and snapshots you made in the Govee app.
- **Looks**: your own colour designs (a palette plus a pattern), built from a colour picker or a photo.
- **Slow movement**: any look can drift through its colours over minutes or hours, with no fast effects.
- **Describe a look** (optional): type what you want, such as "cosy autumn evening", and get designs to preview, adjust and save.
- **Zones**: named groups of lights such as "Front yard". Lights mounted end to end can be joined so they behave as one long light.
- **Schedules**: clock or sunrise/sunset times with offsets, days of the week, an optional turn-off time, and yearly date ranges for seasonal lighting.
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

If a light stops answering locally, its commands go through the cloud until it reappears. The Mac must be on the same network as the lights, and macOS may ask whether Node may accept incoming connections; allow it. Local control uses UDP port 4002, which only one app on the computer can hold, so it will be unavailable if another Govee integration is running there. Set `LAN=0` in `.env` to switch it off.

### Keep it running on a Mac

```bash
./scripts/install-mac.sh
```

This starts Afterglow whenever you log in and restarts it if it stops. Schedules only run while the Mac is on and awake, so in **System Settings → Energy** turn on "Prevent automatic sleeping when the display is off", and enable automatic login if the Mac may reboot unattended. macOS may ask once whether Node may accept incoming connections; allow it. To undo, run `./scripts/uninstall-mac.sh`.

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
- **Movement is slow by design.** On a light reached locally, a look that shows it in one colour (Solid, One per light) moves in tiny steps every 5 to 60 seconds. Through the cloud a moving look takes a small step every minute or so, never more than about 75 requests per light per hour, and pauses for the day if the account gets close to Govee's daily limit. It keeps going until you apply something else, hold it, or switch the lights off, and it carries on after a restart. Fast effects such as chases and flicker come from Govee's own scenes, because the API cannot send colours quickly enough.
- **DIY scenes and snapshots** are created in the Govee app. Use the reload button on the Scenes tab to pick up new ones.
- **Turn-offs are checked.** After a schedule switches lights off, Afterglow asks each light whether it is really off: 1, 3, 10, 30 and 60 minutes later, stopping as soon as all are. A light that is still on, or cannot be reached, is sent "off" again each time. The schedule's card then shows "confirmed off", or names the lights that are still on or unreachable, which are also marked on the Lights page. A light stops being checked as soon as it is seen off or anything else is applied to it, so turning one back on yourself is respected. Lights reached locally answer for themselves; for the rest the check relies on what Govee's cloud reports.
- **Overlapping schedules**: when two start at the same minute, one limited to a time of year wins over an everyday one.
- **Your data** is one readable file, `data/afterglow.json`. Copy it to back up looks, zones and schedules.

## Development

```bash
npm run dev
```

Runs the server with reload and the web app at <http://localhost:5173>.

```bash
npm test
```

| Path | What it holds |
| --- | --- |
| `server/govee/cloud.ts` | Client for Govee's cloud API |
| `server/govee/lan.ts` | Client for Govee's local network API |
| `server/govee/fake.ts` | Simulated Govee service used by demo mode and the tests |
| `server/govee/fake-lan.ts` | Simulated local-network lights for demo mode and the tests |
| `server/hub.ts` | Lights, their state, and turning actions into commands |
| `server/queue.ts` | Per-light command pacing and retries |
| `server/scheduler.ts` | Schedule times, including sunrise and sunset |
| `server/animator.ts` | Advances moving looks step by step |
| `server/mcp.ts` | MCP tools |
| `server/ai.ts` | Look ideas from a description, via the Claude API |
| `shared/` | Types, colour maths and look patterns used by both sides |
| `web/src/` | The React app |
