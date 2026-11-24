Deep Connect opens Termix sessions from Lansweeper asset action links: saved hosts by name or address with their own log-ins, or ad-hoc quick connects to an address over SSH, RDP or VNC, always behind a confirm dialog.

## Turn it on

1. Install Deep Connect from the Plugins tab (community registry) or a GitHub release.
2. Open Lansweeper asset actions pointing at your Termix URL, or the Connect from link tab from the command palette.

## Use it

Click a Lansweeper asset action (or paste a `?view=deep-connect&connect=…` link into your
browser). The plugin's own view opens and asks you to confirm; accepting finishes in
Termix itself — the view finds or saves the record, then Termix opens in one new tab where
you start the session from the Hosts list. The view never opens sessions itself and says
so plainly; a link that cannot be completed there (no credential to attach, an unknown
host or credential name, a failed save) opens nothing. Cancelling closes the card without
opening anything. Using the link flow needs the Connect permission, which admins and users
get by default.

Full link recipes for Lansweeper administrators are in [the setup guide](lansweeper-setup.md).
