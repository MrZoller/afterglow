# Security

## What Afterglow is designed for

Afterglow is meant to run on a computer at home and be used from that home network, or from a private network such as Tailscale. It is not designed to be reachable from the public internet. Do not forward a router port to it.

## Who can use it

- **By default, anyone who can reach it.** There is no login unless you set one, so any device on the same network can control the lights.
- **With a passphrase.** Set `ACCESS_TOKEN` in `.env` and restart. The page, the REST API and the MCP endpoint then all require it. The browser keeps a value derived from the passphrase, never the passphrase itself.
- **Other websites are kept out.** Requests are only accepted when addressed to a local name or address (an IP address, `localhost`, a single-word hostname, or a name ending in `.local`, `.lan`, `.home`, `.home.arpa`, `.internal` or `.ts.net`), and requests that change anything must come from Afterglow's own pages. This stops a web page open in your browser from sending commands to your lights. Extra hostnames can be allowed with `ALLOWED_HOSTS`.

An AI assistant connected over MCP can do everything the page can: control lights and create, change or delete looks and schedules. Everything it does is recorded under Recent activity.

## Secrets and stored data

- The Govee API key, the passphrase, the Anthropic API key and the notification address and token live only in `.env`, which is not committed and is never included in backups.
- `data/` holds your looks, zones, schedules, the location you entered, light names, Govee's identifiers for your lights, and a two-week record of when each light could not be reached. It is not committed. Backups contain your setup from it, minus anything in `.env`.

## What leaves your computer

- **Govee's cloud API**: commands and state reads for your lights, authenticated with your Govee key.
- **Anthropic's API**, only when you use Describe a look: your description, the look being edited, how many lights and segments you have, and the names of built-in scenes. Light names, zones and location are not sent.
- **Your local network**: UDP messages to the lights on ports 4001 to 4003 when local control is on. With designs over your own network switched on, these include a message Govee does not document; it goes only to your own lights.
- **A notification service**, only when `NOTIFY_URL` is set: a short message naming the schedule and the lights concerned, the time, and an address that opens Afterglow on your network, posted to the address you chose. With ntfy.sh, anyone who knows the topic name can read these, so choose one that cannot be guessed, or run your own ntfy server.

Nothing else is sent anywhere. There is no telemetry.

## Reporting a problem

Open an issue on this repository. If the repository is public and the problem could put someone's lights or network at risk, use GitHub's private vulnerability reporting instead of a public issue.

Only the latest version on `main` is maintained.
