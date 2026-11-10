# Use Deep Connect from Lansweeper asset actions

Deep Connect turns a Lansweeper **asset action link** into a Termix session. On the
Lansweeper side you configure the link once (per site or per action), and every asset can
then start the right Termix session in one click.

## Create the asset action

In Lansweeper, add an asset action ("Manage → Asset actions" on classic setups) of the kind
that **opens a URL**, and point it at your Termix server using one of the recipes below.
Lansweeper fills its template tokens before the browser navigates — the exact token syntax
depends on your Lansweeper version (newer releases use `{NAME}`, `{IPADDR}`, …).

## Recipes per protocol

Replace `termix.example.com` with your Termix URL and adjust tokens to your Lansweeper
version's syntax.

**SSH (default connect — opens the host's default connection):**

```
https://termix.example.com/?view=deep-connect&connect={NAME}
```

**RDP to an address, with a named credential and an AD domain:**

```
https://termix.example.com/?view=deep-connect&connect={IPADDR}&type=rdp&credential=%5BCREED%5D&domain=WAG&using=adhoc
```

**VNC to an address with a port override:**

```
https://termix.example.com/?view=deep-connect&connect={IPADDR}&type=vnc&credential=%5BVNC%5D&port=5900&using=adhoc
```

**Saved host by address (no type — the host keeps its own log-in):**

```
https://termix.example.com/?view=deep-connect&connect={IPADDR}
```

## Grammar

Every parameter is optional except `connect`:

| Parameter    | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `connect`    | Saved host name or IP; an ad-hoc address otherwise              |
| `type`       | `ssh`, `rdp`, `vnc` or another registered plugin protocol       |
| `credential` | Credential name, resolved against the user's own list           |
| `port`       | Port override (ad-hoc connects only)                            |
| `domain`     | AD domain for ad-hoc RDP direct auth                            |
| `using`      | `adhoc` forces an ad-hoc connect; `name` forces the host lookup |
| `viewonly`   | Reserved (parsed, shown in the confirm text, not applied yet)   |

`credential` and `port` must be percent-encoded when they contain spaces or special
characters.

## Caveats

- The link carries **names only, never secrets**. The confirm dialog always shows first;
  cancelling clears the link from the URL.
- **Saved hosts** connect with their own stored log-ins — a `credential=` name is verified
  and shown in the confirm text, but does not replace the host's login.
- **Ad-hoc links** cannot carry a stored password or key: the session stops at Termix's
  own prompt (SSH) or remote-desktop's prompt (RDP/VNC), and the confirm dialog states it.
- Signed-out browsers get the Termix login first and return to the link; unknown
  parameters and `view=` are dropped on the way by the hand-off page.
- Termix needs engine 26.11.1 or newer and the plugin enabled for your role
  (admins and users by default).
- Verify the template-token syntax against your own Lansweeper version before rollout —
  it varies between releases.
