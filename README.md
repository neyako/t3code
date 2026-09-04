# T3 Code

T3 Code is an open-source control surface for coding agents. Run agents on your machine and
control them from the local web app, [iOS app](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824),
[Android app](https://play.google.com/store/apps/details?id=com.t3tools.t3code), desktop app, or
another computer.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.
This fork also adds first-class [Pi](https://pi.dev) support through the community `pi-acp`
adapter while keeping T3 Code's provider and remote-access workflow intact.

## What this fork adds

- Pi Agent provider powered by `pi-acp` and `pi --mode rpc`
- Pi model discovery scoped to providers configured in Pi
- Per-model thinking-level controls when Pi advertises them
- Pi skills and slash-command discovery
- Context-window usage and remaining-context display
- `/compact` support, including a visible message when there is nothing to compact
- Stall detection that settles dead Pi turns instead of leaving them running forever
- Official Pi logo in the fork's web and mobile clients

T3 Code remains remote-ready and multi-surface: the server owns provider processes, projects,
files, git state, and sessions; clients connect to that server.

## Providers

T3 Code drives provider CLIs; it does not ship them. Install and authenticate each provider on
the machine running the T3 Code server.

| Provider    | CLI                                                                  | Default binary | Authentication        |
| ----------- | -------------------------------------------------------------------- | -------------- | --------------------- |
| Codex       | [Codex CLI](https://developers.openai.com/codex/cli)                 | `codex`        | `codex login`         |
| Claude      | [Claude Code](https://claude.com/product/claude-code)                | `claude`       | `claude auth login`   |
| Cursor      | [Cursor CLI](https://cursor.com/cli)                                 | `cursor-agent` | `agent login`         |
| Grok Build  | [Grok Build CLI](https://x.ai/cli)                                   | `grok`         | `grok login`          |
| OpenCode    | [OpenCode](https://opencode.ai)                                      | `opencode`     | `opencode auth login` |
| Antigravity | Built-in managed runtime                                             | Automatic      | Google sign-in        |
| Pi Agent    | [Pi](https://pi.dev) + [`pi-acp`](https://github.com/svkozak/pi-acp) | `pi-acp`       | Pi's provider setup   |

Codex and Claude are enabled by default. Other providers can be enabled from **Settings**.

### Pi setup

Install Pi and the ACP adapter globally:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
npm install -g pi-acp
```

Run Pi once to configure and authenticate a provider. Pi stores its configuration under
`~/.pi/agent`; T3 Code reads that configuration to discover available providers, models,
thinking levels, skills, and commands.

Make sure both `pi` and `pi-acp` are on the server process's `PATH`. If they are installed in a
non-standard location, set the Pi provider's **Binary path** in **Settings** to the full path of
`pi-acp`.

## Installation

### Use the upstream release

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

For the upstream provider set, install and run the released server:

```bash
npx t3@latest
```

This fork's Pi support is not included in the upstream npm release. Use the source setup below
when you want Pi Agent support.

### Run this fork from source

Requirements:

- Node.js 24.13.1 or newer
- `vp` (Vite+)
- At least one authenticated provider CLI

Install `vp`:

```bash
curl -fsSL https://vite.plus | bash
```

Clone and start the fork:

```bash
git clone https://github.com/neyako/t3code.git
cd t3code
vp i
vp run dev
```

To connect from a phone or another computer on your LAN, bind the server to all interfaces:

```bash
vp run dev --host 0.0.0.0
```

The dev runner prints a pairing URL. Open that URL from the client you want to pair. For a
tailnet or another trusted remote network, use:

```bash
vp run dev --share
```

Use `vp run dev --help` for the available server and web options.

### Desktop app

Upstream desktop releases are available from [GitHub Releases](https://github.com/pingdotgg/t3code/releases)
and package registries:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

For the nightly build:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in [`packaging/aur`](./packaging/aur).

For the fork's Pi-specific client UI, build the web, desktop, or mobile client from this
repository. Existing upstream clients can still connect to the server, but may display Pi as a
generic provider until they include the fork's client changes.

## Remote access

The server can be controlled from the official T3 mobile or desktop app, the fork's local web
client, or another browser.

- **LAN:** bind with `--host 0.0.0.0` and pair using the server's LAN URL.
- **SSH:** use the desktop app's remote-environment SSH flow.
- **Tailnet/HTTPS:** use `vp run dev --share`, Tailscale Serve, or another trusted HTTPS endpoint.

The hosted web app at [app.t3.codes](https://app.t3.codes) runs on HTTPS. Browsers block it from
connecting directly to a plain `http://192.168.x.y:PORT` backend. Use an HTTPS endpoint for the
hosted app, or open the direct LAN pairing URL from a client that can connect to HTTP.

Provider credentials stay on the server machine. Pairing grants a client access to that server;
it does not move provider keys to the phone or browser.

See [Remote access](./docs/user/remote-access.md) for pairing, Tailscale, SSH, and troubleshooting.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- [Running T3 Code in the background](./docs/user/background-service.md)
- [Building from source](./docs/internals/overview.md)

## Contributing

```bash
vp i
vp run dev
vp typecheck
vp test
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a pull request.
Small fixes are welcome; discuss larger features in [Ideas](https://github.com/neyako/t3code/discussions/categories/ideas).

Need help? Join the [Discord](https://discord.gg/jn4EGJjrvv).

## License

T3 Code is released under the [MIT License](./LICENSE).
