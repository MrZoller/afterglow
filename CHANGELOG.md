# Changelog

Changes that affect how Afterglow behaves, newest first. Dates are year-month-day.

## Unreleased

Nothing yet.

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
