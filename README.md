# Deep Connect

Launch Termix sessions from deep links (URI → session launcher; built for Lansweeper asset actions)
links. A link opens a Termix confirm dialog first; only after you accept it does a session
start, with the deep-link details scrubbed from the URL.

This is a community plugin for [Termix](https://github.com/Termix-SSH/Termix). Its backend
surface is exactly one authenticated route — the ad-hoc host adoption POST (`hosts:write` +
`network:serve`) — plus the empty `backend.js` entry every plugin is loaded through; it
keeps no table and makes no outbound network call: it reads your visible host list,
resolves a credential by name, and hands the session to Termix's own connect path.

## What it does

- **Saved hosts** — `?connect=<host name|ip>` matches a saved host (case-insensitive name
  first, exact address second) and opens it the way clicking it in the host list does, with
  its own log-in.
- **Ad-hoc addresses** — with `using=adhoc`, or when nothing matches and a type is present,
  the address is opened as an ephemeral quick connect over SSH, RDP or VNC (registered
  plugin protocols).
- **Credentials by name** — `&credential=<name>` verifies a saved credential against your
  own list and shows it in the confirm text. It never reads a secret and nothing secret is
  ever carried in the link.
- **A confirm before every connect** — the `?view=` page shows its own confirm card on the
  web; the desktop and app-shell paths use the styled Termix dialog. Cancelable, and
  nothing opens or is written before you accept.
- **`viewonly=1`** — applies on ad-hoc RDP/VNC quick connects: the session opens with input off.
  Restrict-only — honored exactly as `1` (every other value is ignored) and scrubbed from the URL
  afterwards; saved hosts and SSH links see it as a note only.

## Install

1. Enable the community registry under **Plugins → Registries** (or load the `.tmxplug`
   from a GitHub release).
2. Install **Deep Connect** from the Plugins tab.
3. Use the **Connect from link** tab (or any Lansweeper link below).

## Link grammar

```
https://<termix>/?view=deep-connect&connect=<name|address>&type=<ssh|rdp|vnc>&credential=<name>&port=<n>&domain=<AD>&using=<name|adhoc>&viewonly=1
```

| Parameter    | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `connect`    | Saved host name or IP; an ad-hoc address otherwise              |
| `type`       | `ssh`, `rdp`, `vnc` or another registered plugin protocol       |
| `credential` | Credential name, resolved against your own list                 |
| `port`       | Port override (ad-hoc connects only)                            |
| `domain`     | AD domain for ad-hoc RDP direct auth                            |
| `using`      | `adhoc` forces an ad-hoc connect; `name` forces the host lookup |
| `viewonly`   | Ad-hoc RDP/VNC: session opens with input off (exact `1` only)   |

The `?view=deep-connect` page IS the web entry: core opens the plugin's own full-screen
view there, which renders its own confirm card from the link (target, connection type,
credential by name, view-only). Clicking **Connect** opens the session from inside that
view — saved hosts straight away, credentialed ad-hoc links by saving the record on your
confirm and connecting to it. When Termix's app surface cannot act from the view, one new
browser tab may open to finish the connect (it auto-connects there, no second confirm);
failures dead-end with a clear error card instead of re-opening windows. A bare
`/?connect=…` URL is **desktop-only**: Termix 26.11.3 routes it in the desktop app's
`termix://` handling but never on the web, so keep links on the `?view=` form.

## Desktop `termix://` links

In the desktop app, the same grammar is reachable through the OS scheme (Termix 26.11.3):

```
termix://connect/<target>?<grammar>
termix://<any-authority>?connect=<target>&<grammar>
```

For example: `termix://connect/Web%20Server%201?type=vnc&viewonly=1` or
`termix://deep-connect?connect=10.0.0.5&type=rdp&credential=Deploy%20Key&port=3389&using=adhoc`.

- The first form carries the target in the path; the second in a parameter. The authority slot is
  not significant to the grammar — any authority works.
- Core's own `termix://host/<id>` links (a saved host by numeric id) are core's and deliberately
  excluded from this grammar: Termix handles those itself.
- Every source confirms first — including `command-line` links (launched straight from a command
  line). Nothing opens and nothing is written before the dialog is accepted.
- Replays are ignored per session: the desktop layer re-delivers recently seen links to every new
  listener (a plugin disable/enable cycle does), and a link that already ran its confirm this
  session does not run again — the same guard core applies to its own links.

## How it is built

- `src/frontend/deep-link.ts` — the URL grammar: parse, host lookup, parameter scrubbing.
- `src/frontend/connect-plan.ts` — the pure plan: pick the saved host, verify the
  credential name, build the quick-connect record, decide which tab type passes through.
- `src/frontend/consumer.ts` — the activate-time consumer: waits for the shell and both
  registries, asks once, connects, or explains with a toast.
- `src/frontend/StandaloneHandoff.tsx` — the standalone `?view=` page: the web consumer
  (confirm-first card from `props.params`, in-view connect, one-shot go=1 fallback).
- `src/frontend/index.tsx` — activation: the tab registration and the consumer.

## Honest limitations (v2.0)

- **Ad-hoc RDP/VNC with `credential=`**: a matching named credential rides the quick connect by
  id (`quickConnectLogin.credentialId`) and is resolved server-side by the protocol plugin when
  the session opens — the secret never reaches the browser, and the confirm dialog names the
  credential it will use. What this plugin can additionally do, on the link's confirm, is offer
  to create a saved host in the **Ad-Hoc Hosts** folder with the credential attached by id
  (created through the plugin backend, which sees ids only), and then connect through the
  saved-host flow — where Termix expands the credential server-side and the record makes the
  link keep working from then on. Declining adoption does not downgrade the link to a prompt:
  the quick connect still carries the id. An unmatched credential name is refused, never
  downgraded. The adopt route declares `hosts:write` (the record create) and
  `network:serve` (it is an authenticated plugin API route); it reads nothing secret.
- **Ad-hoc SSH with `credential=`**: the one prompt-led path left. A saved credential still
  cannot ride a quick SSH connect (SSH server-side credential resolution is a future core
  change): adoption makes it a real log-in through the saved flow, and in the fallback the
  username is carried and the session stops at Termix's own SSH auth prompt (a plugin's SDK
  cannot inline a secret — core's own deep-link path can).
- **Key-type credentials** work the same as password ones through adoption (the credential rides
  by id and Termix applies the key server-side); in the fallback they resolve by name and surface
  in the confirm text, but the private key stays in Termix.
- **`viewonly=1`** applies only on ad-hoc RDP/VNC quick connects (opens with input off); saved
  hosts and SSH links show the note without acting on it, and a host's own read-only setting
  still applies where Termix provides one.
- The credential id is offered by the SDK generically to whichever protocol plugin handles the
  connect — remote-desktop resolves it server-side today, SSH has no server-side resolution yet,
  and a hypothetical protocol plugin that ignores the id would open unauthenticated. The confirm
  dialog always names the credential, so never accept a link that names a log-in you do not
  expect.
- A link with no saved match and no type is refused; an ad-hoc link whose type no registered
  plugin provides is refused with a toast (and the `?view=` page refuses it on the confirm
  click, when the registry has settled).
- In the web `?view=` flow an ad-hoc link **without a matched `credential=`** cannot open:
  Termix's plugin frames open sessions by saved host id only. The view says so plainly and
  opens nothing. The same link works from the desktop app (`termix://…`), where Termix's own
  quick-connect prompt path runs in the shell.
- Created hosts carry a generic `ad-hoc` tag and a dated note, in the `Ad-Hoc Hosts` folder. The
  plugin never deletes records; clear the folder yourself whenever you want.

# Positioning

The link grammar is source-agnostic — any web page, bookmark or asset-manager action that can
open a URL can drive it. Lansweeper is the featured consumer (its URL actions are why this
exists), but nothing in the plugin is Lansweeper-specific: created records, folder and tags are
deliberately unbranded.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and the plugin notes in [AGENTS.md](AGENTS.md).
Lansweeper-side setup is in [docs/lansweeper-setup.md](docs/lansweeper-setup.md).

## License

Apache-2.0
