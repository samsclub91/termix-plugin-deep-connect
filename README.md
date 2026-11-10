# Deep Connect

Launch Termix sessions from deep links (URI → session launcher; built for Lansweeper asset actions)
links. A link opens a Termix confirm dialog first; only after you accept it does a session
start, with the deep-link details scrubbed from the URL.

This is a community plugin for [Termix](https://github.com/Termix-SSH/Termix). It declares
no backend surface (the bundle's `backend.js` is the empty entry every plugin is loaded
through), keeps no table and makes no outbound network call: it reads your visible host
list, resolves a credential by name, and hands the session to Termix's own connect path.

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
- **A confirm before every connect** — the styled Termix dialog, cancelable, with the URL
  scrubbed either way.
- **`viewonly=1`** — parsed and scrubbed, but not applied yet (reserved upstream).

## Install

1. Enable the community registry under **Plugins → Registries** (or load the `.tmxplug`
   from a GitHub release).
2. Install **Deep Connect** from the Plugins tab.
3. Use the **Connect from link** tab (or any Lansweeper link below).

## Link grammar

```
https://<termix>/?connect=<name|address>&type=<ssh|rdp|vnc>&credential=<name>&port=<n>&domain=<AD>&using=<name|adhoc>&viewonly=1
```

| Parameter    | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `connect`    | Saved host name or IP; an ad-hoc address otherwise              |
| `type`       | `ssh`, `rdp`, `vnc` or another registered plugin protocol       |
| `credential` | Credential name, resolved against your own list                 |
| `port`       | Port override (ad-hoc connects only)                            |
| `domain`     | AD domain for ad-hoc RDP direct auth                            |
| `using`      | `adhoc` forces an ad-hoc connect; `name` forces the host lookup |
| `viewonly`   | Reserved (parsed, shown in the confirm, not applied yet)        |

For the canonical link shape that survives signed-out users and unknown parameters, open
URL actions through the hand-off page:
`?view=deep-connect&…` — it keeps the seven deep-link parameters, drops the rest, and
relaunches the app at its root, where the consumer runs with the real shell. A raw
`/?connect=…` link also works directly.

## How it is built

- `src/frontend/deep-link.ts` — the URL grammar: parse, host lookup, parameter scrubbing.
- `src/frontend/connect-plan.ts` — the pure plan: pick the saved host, verify the
  credential name, build the quick-connect record, decide which tab type passes through.
- `src/frontend/consumer.ts` — the activate-time consumer: waits for the shell and both
  registries, asks once, connects, or explains with a toast.
- `src/frontend/StandaloneHandoff.tsx` — the full-page hand-off for `?view=` links.
- `src/frontend/index.tsx` — activation: the tab registration and the consumer.

## Honest limitations (v1.1)

- **Ad-hoc RDP/VNC with `credential=`**: the plugin itself still cannot obtain a credential's
  secret. The SDK only redacts credential summaries, and remote-desktop's quick-connect login has
  no credential-id support yet. What this plugin can do is offer, on the link's confirm, to create
  a saved host in the **Ad-Hoc Hosts** folder with the credential attached by id (created through
  the plugin backend, which sees ids only), and then connect through the saved-host flow — where
  Termix expands the credential server-side and the session opens for real. Decline or an
  unavailable route, and the v1 behavior takes over: carried username/domain, remote-desktop's own
  password prompt. The adopt route declares `hosts:write` (the record create) and
  `network:serve` (it is an authenticated plugin API route); it reads nothing secret.
- **Ad-hoc SSH with `credential=`**: same story. Adoption makes it a real log-in through the saved
  flow; in the fallback the username is carried and the session stops at Termix's own SSH auth
  prompt (a plugin's SDK cannot inline a secret — core's own deep-link path can).
- **Key-type credentials** work the same as password ones through adoption (the credential rides
  by id and Termix applies the key server-side); in the fallback they resolve by name and surface
  in the confirm text, but the private key stays in Termix.
- **`viewonly=1`** is not applied; a host's own read-only setting still applies where Termix
  provides one.
- A link with no saved match and no type is refused; an ad-hoc link whose type no registered
  plugin provides is refused with a toast (and the `?view=` page refuses it before handing
  off, when the registry has settled).
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
