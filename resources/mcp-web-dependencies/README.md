# Her web tools dependency installation

Install Node.js separately (>=20.18.1), and retain its real executable. This directory contains the fixed npm manifests, not Node or browser binaries.

For a packaged application, replace `/path/to/Her.app` with the app's actual location:

```sh
mkdir -p "$HOME/.local/share/her/dependencies/web-tools-v1"
cp "/path/to/Her.app/Contents/Resources/mcp-web-dependencies/package.json" "/path/to/Her.app/Contents/Resources/mcp-web-dependencies/package-lock.json" "$HOME/.local/share/her/dependencies/web-tools-v1/"
cd "$HOME/.local/share/her/dependencies/web-tools-v1"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
```

From a checkout, copy the two manifests from `resources/mcp-web-dependencies/` instead. No checkout is needed for the packaged recipe. Reopen Her's MCP preset and check its dependencies; the app saves resolved executable paths for GUI launches.

Playwright MCP 0.0.83 uses existing Chrome with the official Playwright extension `mmlmfjhmonkocbjadbfplnigmagldckm`. Install/approve the extension yourself and choose the intended tab scope. Her's action confirmation is separate from extension approval. Do not use another browser/profile to claim existing Chrome acceptance.

open-webSearch 2.2.0 is optional and disabled by default. Its preset uses request-only public search/fetch, not Chrome login state. The lock installs both packages but does not enable either service automatically.
