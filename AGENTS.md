# AGENTS.md

This repo is a [Termix](https://github.com/Termix-SSH/Termix) plugin. These notes are for AI coding tools.

## Read first

Before changing anything, read `node_modules/@termix-ssh/plugin-sdk/PLUGIN-GUIDE.md`. It covers the
manifest, backend, database, frontend, UI, testing, releasing and submitting to the community registry,
and it matches the SDK version installed here. If it is missing, run `npm install`. If it is still missing,
the SDK is older than 1.0.6: run `npm install -D @termix-ssh/plugin-sdk@latest` or read
https://docs.termix.site/develop instead.

If the guide and the SDK's TypeScript types disagree, the types are right.

## What this plugin is

`deep-connect` launches Termix sessions from deep links (`?connect=…`, built for Lansweeper
asset actions, and desktop `termix://` links). Its backend registers exactly one route — the
authenticated adoption POST (`hosts:write` + `network:serve`), no tables, no outbound network
calls — so capabilities are exactly `ui:surface`, `hosts:read`, `hosts:write`,
`credentials:use`, `network:serve`.

## Architecture (do not break these)

- **Two entries, one consumer.** Link A is `?view=deep-connect&…` on a browser: core
  mounts ONLY this plugin's standalone component there, with no shell and unbound shell
  callbacks — `app.tabs.connectHost` and the styled `app.confirm` are silent no-ops on that
  page. That is why `StandaloneHandoff.tsx` is a full-page hand-off that relaunches the app
  at `/?connect=…` (same seven params minus `view=`), where `consumer.ts` runs with the real
  shell. Link B is a raw `/?connect=…`, consumed directly.
- **`deep-link.ts`** started as a 1:1 port of core's `src/ui/shell/deep-link.ts` (Termix repo,
  feat/deep-link-website-connector): strict truthiness, param scrubbing; it also holds the
  desktop `termix://` parser (`parseTermixLinkUrl`: `termix://connect/<target>?…` and
  `termix://<any-authority>?connect=…`; core's `termix://host/<id>` excluded). `viewonly` is
  parsed and scrubbed here and APPLIED down-stream — connect-plan stamps
  `quickConnectLogin.viewOnly` on ad-hoc RDP/VNC quick connects (exact `1`, restrict-only).
  Its tests are the core suite adapted to `PluginHostRecord`.
- **`connect-plan.ts` is pure** — hosts/credentials/protocols come in as data and the
  quick-connect builder is injected. Never add fetches, DOM or timing here.
- **Secrets never travel.** The SDK exposes no credential detail route to plugins; the list
  is redacted. A verified credential rides by ID on ad-hoc RDP/VNC quick connects
  (`quickConnectLogin.credentialId`, resolved server-side by the protocol plugin — the secret
  never reaches the browser); SSH-type ad-hoc connects keep the username-riding v1 shape and
  stop at a prompt. An unmatched credential name is refused, never downgraded. Never build
  any code path that fetches or inlines a secret.
- **The credential-id stamp is protocol-generic.** `quickConnectLogin.credentialId` is offered
  to whichever registered protocol plugin consumes the connect — remote-desktop resolves it
  server-side today, SSH quick connects have no server-side credential expansion yet (a future
  core change), and a hypothetical protocol plugin that ignores the id would open
  unauthenticated; the confirm dialog always names the credential. Do NOT gate the stamp on
  `pluginId === "remote-desktop"`: that would freeze a protocol-generic seam to the wrong
  consumer.
- **`connectionType` must be set explicitly** on ad-hoc quick-connect records
  (`coreSsh ? "ssh" : protocol.id`): remote-desktop reads `quickConnectLogin` only when the
  two match, and `createQuickConnectHost` leaves it unset.
- **`type=ssh` must never be passed as a tab type** — the ssh-terminal plugin registers
  `"terminal"`. Pass `intent.type` through only when it matches `listHostProtocols()`;
  otherwise poll `getDefaultConnectionTab(host)` (~2 s) before failing.
- **`?view=` no-op:** the consumer must not run on a standalone page (`params.has("view")`
  early return), and the hand-off owns that URL's deep-link parameters.
- **StrictMode/double-run:** the hand-off captures `location.search` once in a `useState`
  initializer; the consumer uses a module-scoped `consumed` flag. URL is scrubbed first, so
  re-parses are no-ops. Desktop `termix://` links dedup the same way: core replays its recent
  links to every new registration, so `startTermixLinkConsumer` keeps a module-scoped
  WeakSet keyed on link object identity (port of core's own guard) — a replay never
  re-confirms.

## Commands

```bash
npm run build        # bundle into dist/
npm test             # run the tests
npm run typecheck    # type check
npm run validate     # check manifest.json, changelog and docs
npm run pack         # write <id>-<version>.tmxplug
npm run format       # format with Prettier
```

## Done means

- `npm test`, `npm run typecheck`, `npm run validate`, `npm run build` and `npm run format:check` pass
- New UI text is in `locales/en.json`
- `docs/` and the section below still match what the plugin does
- User facing changes are in `CHANGELOG.md` under the version they ship in
- Community releases: run the Release workflow by hand from a fresh `dev-X.Y.Z` branch
  (channel stable|beta × mode release|overwrite|dry-run); the registry checks build
  provenance, so never replace the template workflows

## About this plugin

- The plugin id is immutable after the first release; registry listing expects the repo
  name `termix-plugin-deep-connect` and the id `deep-connect`.
- The consumer's settle window (hosts + protocol registries, ~4 s) deliberately falls
  through when nothing settles: a user with zero hosts still gets ad-hoc links, at the cost
  of a slow refusal toast when the registries never came up.
- Remaining gaps are documented honestly in README "Honest limitations": a plugin can never
  carry a credential secret (the SDK redacts summaries and has no detail route, so secrets stay
  server-side), and ssh-terminal expands stored credentials only for hosts with a numeric id —
  the reason core's own deep-link fix inlines passwords, which plugins cannot do.
