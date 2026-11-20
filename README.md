# Afterglow

A friendly control panel for Govee outdoor lights. It runs on a computer at home (a Mac mini is ideal) and gives you:

- **One page for everything**, on phone and desktop: on/off, brightness, colour, white, per-segment painting.
- **Govee scenes**: built-in scenes, plus the DIY scenes and snapshots you made in the Govee app.
- **Looks**: your own colour designs (a palette plus a pattern), built from a colour picker or a photo.
- **Describe a look** (optional): type what you want, such as "cosy autumn evening", and get designs to preview, adjust and save.
- **Zones**: named groups of lights such as "Front yard".
- **Schedules**: clock or sunrise/sunset times with offsets, days of the week, an optional turn-off time, and yearly date ranges for seasonal lighting.
- **AI agent access**: a built-in MCP server so an assistant such as Claude can control the lights.

Without an API key it runs in **demo mode** with eight simulated lights, so you can try it first.

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

### Keep it running on a Mac

```bash
./scripts/install-mac.sh
```

This starts Afterglow whenever you log in and restarts it if it stops. Schedules only run while the Mac is on and awake, so in **System Settings → Energy** turn on "Prevent automatic sleeping when the display is off", and enable automatic login if the Mac may reboot unattended. macOS may ask once whether Node may accept incoming connections; allow it. To undo, run `./scripts/uninstall-mac.sh`.

### Use it from your phone

On the same Wi-Fi, open `http://<your-mac's-name>.local:4680` (the name is under System Settings → General → Sharing), or use one of the addresses printed when Afterglow starts. In Safari choose **Share → Add to Home Screen** to get an app icon.

To use it away from home, put the Mac and your phone on a private network such as [Tailscale](https://tailscale.com) rather than opening a port on your router.

### Lock it with a passphrase

Anyone on your network can open the page. To require a passphrase, set `ACCESS_TOKEN=` in `.env` and restart. The same value protects the API and the MCP endpoint.

## Describe a look

With an Anthropic API key, the look editor gains a box where you describe what you want. It returns three designs; pick one to load it into the editor, then adjust, try it on the lights and save it like any other look. Follow-up requests such as "warmer, less purple" refine the look you are editing. Because looks are still, it also points out built-in animated Govee scenes that fit the description.

1. Create an API key in the [Claude Console](https://platform.claude.com).
2. Add it to `.env` as `ANTHROPIC_API_KEY=` and restart Afterglow.
3. Open **Looks → Describe**, or use the box at the top of any look you are editing.

Each request is a call to Claude (`claude-opus-5-5`) billed to your Anthropic account. What is sent: your description, the look being edited, how many lights and segments you have, and the names of the built-in scenes. Light names, zones and your location are not sent. Everything else in Afterglow works without a key.

## AI agents

Afterglow serves MCP at `http://<host>:4680/mcp`. For Claude Code:

```bash
claude mcp add --transport http afterglow http://localhost:4680/mcp
```

With a passphrase, add `--header "Authorization: Bearer <passphrase>"`. Clients that only speak stdio (such as Claude Desktop's config file) can bridge with `npx mcp-remote http://localhost:4680/mcp`.

Tools: `list_lights`, `control_lights`, `paint_segments`, `list_scenes`, `apply_scene`, `list_looks`, `save_look`, `apply_look`, `delete_look`, `list_schedules`, `save_schedule`, `set_schedule_enabled`, `delete_schedule`. Agents refer to lights and zones by name. Everything an agent does appears under Settings → Recent activity.

## Things worth knowing

- **Govee limits requests.** Each change to a light is one request, and a design with several colours is one request per colour, per light. Afterglow paces commands, retries when Govee asks it to slow down, and draws gradients in at most eight bands. Settings shows how many requests were sent today.
- **Some state is remembered, not read.** Govee reports power, brightness and a single colour, but not segment colours or the running scene. Afterglow shows what it last applied, and falls back to what Govee reports when it sees the colour change from elsewhere.
- **Animated effects come from Govee scenes.** Looks are static designs; the API is too slow to animate segments from outside.
- **DIY scenes and snapshots** are created in the Govee app. Use the reload button on the Scenes tab to pick up new ones.
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
| `server/govee/fake.ts` | Simulated Govee service used by demo mode and the tests |
| `server/hub.ts` | Lights, their state, and turning actions into commands |
| `server/queue.ts` | Per-light command pacing and retries |
| `server/scheduler.ts` | Schedule times, including sunrise and sunset |
| `server/mcp.ts` | MCP tools |
| `server/ai.ts` | Look ideas from a description, via the Claude API |
| `shared/` | Types, colour maths and look patterns used by both sides |
| `web/src/` | The React app |
