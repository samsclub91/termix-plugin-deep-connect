# Contributing to Lansweeper Connector

## Development

```bash
npm run build      # build into dist/
npm run test       # run this plugin's tests
npm run typecheck  # type-check this plugin
npm run validate   # check manifest.json, changelog and docs
npm run pack       # pack dist/ into a .tmxplug
npm run format     # format the code with Prettier
```

`npx termix-plugin dev --server <url> --key <tmx_...>` installs the plugin on a Termix
server with developer mode on and reinstalls it on every save. Don't start it unless you
are the maintainer.

## Docs

The docs for this plugin are in [docs/](docs/), and `docs` in `manifest.json` links to
them. Permissions are declared in `manifest.json`, so keep that and the locales in
`locales/en.json` up to date instead of writing labels by hand.

## Notes for changes

- The link grammar lives in `src/frontend/deep-link.ts` and is asserted by the ported
  core test suite. If you change the grammar, keep the seven-parameter deep-link list in
  sync with the registry: both the hand-off URL filter and the scrubber use it.
- `src/frontend/connect-plan.ts` is deliberately free of DOM and network access, so tests
  need no registry mocks. Keep it that way.
- Community-plugin releases run from a `dev-1.0.0` branch through the Release workflow
  (channel `stable`, mode `release`; use `dry-run` to test the build). The registry
  submission snippet and sha256 appear in the run summary.
