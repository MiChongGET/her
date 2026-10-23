# Her web tools dependency installation

Install Node.js separately (>=20.18.1), and retain its real executable. This directory contains the fixed npm manifests, not Node or browser binaries.

For a packaged application, replace `/path/to/Her.app` with the app's actual location:

```sh
mkdir -p "$HOME/.local/share/her/dependencies/web-tools-v1"
cp "/path/to/Her.app/Contents/Resources/mcp-web-dependencies/package.json" "/path/to/Her.app/Contents/Resources/mcp-web-dependencies/package-lock.json" "$HOME/.local/share/her/dependencies/web-tools-v1/"
cd "$HOME/.local/share/her/dependencies/web-tools-v1"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
node "/path/to/Her.app/Contents/Resources/mcp-web-dependencies/apply-her-patch.mjs" "$HOME/.local/share/her/dependencies/web-tools-v1/node_modules/open-websearch"
```

From a checkout, copy the two manifests from `resources/mcp-web-dependencies/` instead. No checkout is needed for the packaged recipe. Reopen Her's MCP preset and check its dependencies; the app saves resolved executable paths for GUI launches.

For a checkout, run `node resources/mcp-web-dependencies/apply-her-patch.mjs "$HOME/.local/share/her/dependencies/web-tools-v1/node_modules/open-websearch"` from the repository after installation. Stop the search service before updating its runtime. The patch script verifies the complete official package hash before modifying exactly four files, verifies every resulting file and the complete patched hash, and recognizes a repeated application without changing it. Unknown or partly patched bytes are rejected; reinstall from the fixed lock before retrying.

The npm version and download integrity remain the official `open-websearch@2.2.0`. `her-request-patch.json` separately identifies Her's `her-request-confinement-v1` revision and both complete tree hashes. The Her revision adds an explicit request-only `redirectPolicy: error` through the existing MCP fetch chain and disables Bing's regional redirect follow-up. Both fetch HEAD/GET and Bing requests reject redirects before contacting the next location. It does not introduce a fetcher, proxy or browser fallback. Her only enables bounded automatic HTTP actions after verifying the patched bytes; an official unpatched runtime remains available for exact per-call confirmation.

Browser automation uses the [official ego-browser Skill](https://github.com/citrolabs/ego-lite/tree/main/skills/ego-browser). Follow its installation instructions for ego lite and complete the application's first-run setup. It is separate from MCP presets and this npm lock.

open-webSearch 2.2.0 is optional and disabled by default. Its preset uses request-only public search/fetch, not browser login state. The lock installs its dependencies without enabling the service automatically.
