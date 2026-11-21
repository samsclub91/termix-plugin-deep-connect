Deep Connect opens Termix sessions from Lansweeper asset action links: saved hosts by name or address with their own log-ins, or ad-hoc quick connects to an address over SSH, RDP or VNC, always behind a confirm dialog.

## Turn it on

1. Install Deep Connect from the Plugins tab (community registry) or a GitHub release.
2. Open Lansweeper asset actions pointing at your Termix URL, or the Connect from link tab from the command palette.

## Use it

Click a Lansweeper asset action (or paste a `?view=deep-connect&connect=…` link into your
browser). The plugin's own view opens and asks you to confirm; accepting opens the session
right there (rarely, Termix hands off to one new tab that finishes the connect — no second
confirm), and cancelling closes the card without opening anything. Using the link flow
needs the Connect permission, which admins and users get by default.

Full link recipes for Lansweeper administrators are in [the setup guide](lansweeper-setup.md).
