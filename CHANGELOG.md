# Changelog

Changes that affect how Afterglow behaves, newest first. Dates are year-month-day.

## Unreleased

### Added

- **Multi-colour designs over your own network (experimental).** Designs with several colours can be sent straight to lights that answer locally, instead of through Govee's cloud one request per colour. Where a model takes the message, a design appears at once and uses no requests, and a moving look steps every few seconds whatever its pattern. It is off until switched on per model under Settings → Designs over your own network, where a **Test** button sends a green, blue and red pattern by this route only so you can see whether the model responds. A light that stops answering locally goes back to the cloud.
- **Catching up on missed schedules.** If the computer was off or asleep when a schedule was due, Afterglow carries it out when it is next running, provided it is less than 24 hours old. Each light gets whatever the schedules last said it should be doing, and lights used in the app since are left alone. Settings → Missed schedules has a switch to turn this off.
- **Schedule starts are followed up**, the way turn-offs already were: each light is asked 1, 3, 10, 30 and 60 minutes later whether it came on, and sent the schedule again if not. A light that joins late gets its own share of the design, including its part of a run of joined lights, and joins a moving look where the others have got to.
- **A light still not right after the hour is tried every ten minutes for up to a day**, for starts and turn-offs alike, so one that returns after a power cut or a Wi-Fi drop is brought into line then. The schedule's card says "Still trying to turn off" or "Still trying to start" and names the lights.
- **Phone notifications** through ntfy (set `NOTIFY_URL` in `.env`): when a light is still on, or has not started, ten minutes after a schedule; when that light comes right; and when a schedule ran late. Settings → Missed schedules shows whether they are set up and has a **Send a test** button.
- **A record of lights dropping off the network.** Settings → Lights says how often each light was unreachable in the last seven days, when the last time was and how long it lasted.
- Browser tests (`e2e/`) covering the main flows on every screen, run against the app in demo mode.
- Continuous integration on GitHub: type-check, build, server tests and browser tests on every push to `main` and on pull requests.
- MIT licence.

### Changed

- Messages sent to a light over the local network are now at least 150 ms apart. Lights are reported to drop a message that arrives while they are busy with the one before, and the app used to follow a command with its status query after 120 ms.
- A schedule missed by more than ten minutes used to be skipped. It is now carried out late (see above).
- When several schedules come due together, each light is sent only the one that wins, rather than each in turn.

### Fixed

- Two seconds after a command failed, the app re-read the light and cleared what it showed, even if something newer had been applied in between.

### Known gaps

These additions were developed against simulated lights and a stand-in for the notification service:

- Designs over your own network have not been sent to any real light. The message is undocumented; its layout follows two community projects, neither of which lists the H61A9 or H7086 as tried, and the Home Assistant library lists both models without local segment support. The Test button exists to find out. Also unknown: whether segments are numbered the same way locally as through the cloud, and whether a light already playing a scene switches to the design.
- Notifications have not been sent through the real ntfy service or seen on a phone. The format follows ntfy's documentation.
- Whether Govee's cloud refuses a command for a light that is off the network, or accepts it and does nothing. Both are followed up, but only the simulated versions have been seen.
- How quickly, and how reliably, Govee reports a light as offline and as back. The dropout record and catching up both depend on it for lights not reached locally.
- What a light does when its power returns after a cut (stays off, or comes back as it was).

## 0.1.0 — 2026-11-21

First version. Not tagged as a release.

### Added

- **Control panel** for Govee lights on phone and desktop: on/off, brightness, colour, white temperature, per-segment painting, and Govee scenes (built-in, DIY and snapshots), for one light, a zone, or everything.
- **Looks**: saved designs made of a palette and a pattern (gradient, blocks, alternating, one per light, solid, painted), built with a colour picker or from a photo, with a "try it" button.
- **Slow movement**: a look can drift through its palette over 10 minutes to 4 hours. It runs until something else is applied, it is held, or the lights are switched off, and carries on after a restart.
- **Describe a look** (optional, needs an Anthropic API key): three designs from a description, refinable with follow-ups, plus matching built-in scenes.
- **Zones**: named groups of lights.
- **Lights joined end to end**: a zone can be marked as joined so its lights act as one long light, with per-light order, a Reversed switch, and a test pattern to check the setup.
- **Schedules**: clock or sunrise/sunset times with offsets, days of the week, an optional turn-off time, and yearly date ranges.
- **Turn-off checks**: after a schedule switches lights off, each light is asked whether it is off at 1, 3, 10, 30 and 60 minutes, and sent "off" again if not. The outcome is shown on the schedule and in the activity log.
- **Local network control**: lights with LAN Control switched on are driven directly for power, brightness, single colours, white, state reads and single-colour movement steps, with Govee's cloud as fallback.
- **MCP endpoint** with 13 tools, so an AI assistant can control lights and manage looks and schedules.
- **Access from other devices**: the addresses that work, including over Tailscale, are listed at startup and in Settings. Optional passphrase.
- **Backups**: a daily copy of the setup kept for two weeks, with restore, download, and restore from a file.
- **Help page**: searchable answers by topic, and a list of anything the install still needs set up.
- **Demo mode** with eight simulated lights when no Govee API key is set.
- Mac scripts to start Afterglow at login.

### Fixed

- Labels in Recent activity stretched to the full height of the screen.
- Settings showed only `localhost` as the MCP address.

### Known gaps

Afterglow was developed against simulated lights. These points are not yet confirmed on real hardware:

- Whether Govee's stricter (10 per minute per light) or looser published rate limit applies. The app paces and retries either way, but multi-colour designs may be slow to appear under the stricter one.
- Whether the identifier a light announces on the local network matches the one Govee's cloud reports for it. If not, lights will stay "reached through the cloud".
- Which end of a light is its first segment. The test pattern in the zone editor exists to find out.
- Whether a step of a moving look reads as a fade or a small jump.
- How reliably Govee's cloud reports a light as off or offline, which the turn-off check depends on for lights not reached locally.
- The Mac auto-start script has only been syntax-checked.
- Describe a look has only been run against a stand-in for the Claude API.
