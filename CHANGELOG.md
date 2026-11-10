# Changelog

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
