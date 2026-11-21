# Changelog

## 2.0.0

### Changed

- Ported to plugin API 2 (engine.api `"2"`, `@termix-ssh/plugin-sdk` 2.11.0); requires Termix 26.11.3. API-1 manifests stopped loading on Termix 26.11.2, hence the major bump; nothing about link behavior changed with it
- Web links changed shape to match Termix 26.11.3: the supported entry is now `https://<termix>/?view=deep-connect&<grammar>`. A bare `/?connect=…` URL is not routed by the web UI anymore — it stays a desktop-app behavior, so asset actions should use the `?view=` form
- The `?view=deep-connect` page now consumes the link itself, in place: it is core's own full-screen view (Termix runs API-2 plugins in sandboxed frames there) and renders the plugin's own confirm card (target, type, credential by name, view-only). Because a sandboxed frame has no shell session surface, the page finishes honestly: a saved host — or a credentialed ad-hoc link whose record you agreed to save (the save is verified by the backend response) — opens **Termix in one new tab** with the record ready, and you start the session from the Hosts list there; the card says plainly that the page itself cannot open sessions (Termix requires its shell), with an Open Termix button as the manual path. This keeps every web connect confirm-first while preserving the one-click Lansweeper flow; the earlier relaunch-to-app-root design could not survive core's framing (no top-level navigation from a plugin frame), so the in-view confirm was adopted instead
- Nothing on the web page claims a session anymore: the machinery that handed the connect to a `go=1` tab that "auto-connected" is gone (a frame cannot open sessions — those bridge calls dead-end unobservably there), and so is the false "Session opened" success state. When a link cannot finish on the page — an ad-hoc address without a `credential=` to attach, a type the save route cannot create, a missing host or credential name, a type no plugin provides, or a failed save — it says so plainly and opens nothing; its only control is the manual Open Termix button. A crafted `go=1` link is just an ordinary grammar link now: it shows the same confirm card
- Ad-hoc RDP/VNC links name a credential (`credential=<name>`): the quick connect now carries it by id (`quickConnectLogin.credentialId`) and the remote-desktop plugin resolves it server-side — no username or password rides the link, and its secret never reaches the browser. Ad-hoc SSH keeps the 1.2 behavior exactly (a saved credential still cannot ride a quick SSH connect; its username does, and the session prompts). When the named credential does not exist, the link is refused (the same credentialNotFound refusal as in 1.2).
- Adopting an ad-hoc RDP/VNC link falls back to a quick connect that also carries the credential by id, instead of the old "will be asked for in the session" path; the note about being prompted is gone there

### Added

- `viewonly=1` now applies: ad-hoc RDP/VNC quick connects open with the session's input off (`quickConnectLogin.viewOnly`). It stays restrict-only — the parameter is accepted exactly as `1` and can only turn input off, never on; every other value is ignored. Saved hosts and SSH links still read the note without acting on it
- Desktop app `termix://` links (`app.deepLinks`, Termix 26.11.3) connect through the same grammar: `termix://connect/<target>?type=…` and `termix://…?connect=…&type=…&…` forms reach the same plan, the same confirm and the same connect path as browser `?connect=` links. Core's own `termix://host/<id>` form is left to Termix, and every `termix://` connect still confirms first — the OS scheme is reachable from anywhere, so nothing opens without your click
- Repeated replays of the same desktop link are ignored per session: the desktop layer replays recently seen `termix://` links to every new listener registration (a plugin disable/enable cycle re-delivers them), so a link that already ran its confirm this session is dropped instead of re-confirmed — a port of core's own replay guard

## 1.2.0

### Changed

- Renamed from "Lansweeper Connector" to **Deep Connect** (plugin id `deep-connect`, repo `termix-plugin-deep-connect`): the plugin is a general URI → session launcher; Lansweeper is one consumer of it, documented in the setup guide
- The standalone hand-off page is now `?view=deep-connect` (was `?view=lansweeper-connect`); the plain `?connect=…&type=…` links are unchanged
- The adopt route moved to `/plugin-api/deep-connect/adopt`
- Records already created in the Ad-Hoc Hosts folder keep working unchanged: they are ordinary saved hosts

## 1.1.0

### Fixed

- Records the plugin creates (or ensures) check the remote-desktop `ignore certificate` box on RDP: machines on an AD fleet usually carry a self-signed cert, and a cert prompt would kill the click-through; an existing record self-heals the box on the next click of its RDP link
- A cross-protocol link no longer inherits the record's primary-protocol port: the ensure that adds RDP to a VNC-created host wrote that host's VNC port (5900) as the RDP port, so RDP negotiated against the VNC server and died with "The RDP server sent something the engine could not handle" (credit: caught in production dogfooding); an omitted port now resolves the link protocol's default server-side, and the RDP link's AD domain rides the ensure the same way it rides the create
- A VNC or RDP link that adopts a host now creates a record the link can actually use: the remote-desktop connect toggle lives in the host's `remote-desktop` plugin settings, which the first release never wrote, so adopted records connected over SSH instead (credit: caught in production dogfooding)
- The intended protocol now opens DIRECTLY after an adoption or an ensure: `connectHost` reads the shell's host store, which can lag the write just made, and its fallback opened whichever session the store already knew (a VNC link silently opening the RDP record, or nothing at all) (credit: caught in production dogfooding)
- Adding a second protocol no longer disturbs the first: the ensure writes key-by-key (the settings write merges), leaves the record's primary connection type alone, and only records the plugin itself made have their stray SSH toggle reaffirmed off; a user's record keeps every toggle it has
- The confirm text no longer claims the link's credential when the session will ride the host's saved protocol login (the saved-on-host note replaces the credential note in that case)
- The remote-desktop protocol's connect action is allowed the moment an adopted record exists: the adopted create writes the toggle + port + protocol login together, and the SSH toggle is explicitly off (a host default can no longer turn an adopted VNC record into an SSH host)
- Re-running a VNC/RDP link against a record the plugin made re-asserts the connection (idempotent), so records created from an earlier build repair themselves on the next click; a shared host the user cannot edit still connects with what it has
- A user's own host without a protocol login gets one clear confirm ("Update & connect") that adds the connection by credential reference before connecting; a fully shaped user record is never touched

### Added

- Ad-hoc host adoption: with your confirm, an ad-hoc link with a credential can create a saved host in the `Ad-Hoc Hosts` folder (generic `ad-hoc` tag, date note - no vendor branding) and connect through the saved flow, so the credential expands server-side and VNC/RDP sessions open without the interactive password prompt
- Hosts carry the credential by id, never a secret; a second click of the same link skips straight in (idempotent by name or address)
- POST `/plugin-api/lansweeper-connector/adopt` behind the new `hosts:write` + `network:serve` capabilities

### Changed

- The "credential cannot ride" ad-hoc behavior stays as the fallback when the create is declined or unavailable

## 1.0.0

### Added

- A standalone `?view=lansweeper-connect` hand-off page for Lansweeper asset action links
- Deep-link consumption in the app shell: saved hosts and ad-hoc quick connects over SSH, RDP or VNC
- A confirm dialog before every connect, with the deep-link parameters scrubbed from the URL afterwards
- Credential lookup by name, so a link can name a log-in without carrying any secret
