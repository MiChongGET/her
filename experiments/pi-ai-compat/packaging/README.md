# Electron packaging validation

Run from the Her repository after the isolated experiment dependencies are installed:

```sh
node experiments/pi-ai-compat/packaging/run.mjs
```

The runner copies Her's current `src`, `tsconfig.json`, and `electron.vite.config.ts` into an ignored `packaging/work/<timestamp>` directory. Only the copy receives a probe import, a distinct application name, an empty global shortcut, and an exit after the probe. Production files and dependencies are not changed.

It then:

1. Builds the baseline copy with the existing Electron Vite CLI and starts a real Electron browser/main process until the existing Her renderer has loaded.
2. Builds a second copy with Pi declared as an external runtime dependency. Vite builds the probe's dynamic imports into chunks using the unchanged Her build configuration.
3. Starts the second copy in a real Electron browser/main process. For each of the three protocols it calls the actual Pi SDK against a loopback fixture, covering text, a tool/result/text round trip, and cancellation after the first text delta.
4. Stages built output plus Pi's production dependency closure from the experiment lockfile, packages an arm64 macOS `.app` with `app.asar`, then starts its own executable from an unrelated temporary directory. `NODE_PATH`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, and the development renderer URL are removed. A separate temporary user-data directory is used for every launch.
5. Checks Pi resolves within `app.asar`, and records module resolution paths for Pi, OpenAI, and Anthropic along with runtime versions, renderer URL, process type, packaged status, exit code, observations, and file sizes.

The packager receives no signing or notarization configuration. `asarIntegrityDigest: false` also disables its automatic Electron-framework modification/ad-hoc re-sign step. This is an unsigned local validation artifact, not a distributable release.

Results are in `../results/electron-baseline.json`, `electron-built-pi.json`, `electron-packaged-pi.json`, and `packaging-results.json`. Timing values are single-run diagnostics affected by disk cache and startup conditions, not performance benchmarks. The build-size difference includes the fixture/probe chunks; runtime dependency size is recorded separately because Electron Vite externalizes dependencies by default.

The probes establish local runtime/bundling viability. They do not prove real upstream endpoint compatibility, correct behavior for every malformed stream, credential-provider semantics, or a signed/notarized distribution. The protocol and ChatService suites in the parent experiment cover those separate contracts where specified.
