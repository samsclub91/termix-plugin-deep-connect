# Changelog

## 1.1.0

### Fixed

- A VNC or RDP link that adopts a host now creates a record the link can actually use: the remote-desktop connect toggle lives in the host's `remote-desktop` plugin settings, which the first release never wrote, so adopted records connected over SSH instead (credit: caught in production dogfooding)
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
