<div align="center">

# ✦ Chromiagent

**A terminal in Chrome's side panel, running an AI agent that can see and drive every open tab.**

Made by **SvRvS** · MIT License · macOS

![Chromiagent in Chrome](docs/hero.png)

</div>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.sh | bash
```

The command downloads Chromiagent to `~/.chromiagent`, installs it, starts the local host and opens `chrome://extensions`. Then:

1. Turn on **Developer mode** (top right).
2. Click **Load unpacked**, press `Cmd+Shift+G`, paste with `Cmd+V` (the folder path is already copied), press Enter, then **Select**.
3. Click the puzzle icon in the toolbar and **pin Chromiagent**.
4. Click the ✦ icon, or press `Alt+A`. The panel opens and the agent starts.

**Requirements:** macOS, Google Chrome, [Node.js](https://nodejs.org) 22.13+, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`, signed in).

## Why it exists

Chrome's built-in Gemini panel is good for chatting about a page. Chromiagent is for getting work done in the browser: you type a task in plain words, and an agent reads, clicks and types across all your tabs while you watch it in a real terminal.

![Chromiagent vs Gemini in Chrome](docs/compare.png)

| | Chromiagent | Gemini in Chrome |
|---|---|---|
| Acts on pages (click, type, navigate) | Yes, for everyone | "Auto browse" is limited to paid Google AI Pro / Ultra plans in the U.S. |
| Open tabs it can see | All tabs in all windows, on its own | The current tab, plus tabs you add with `@` |
| Real terminal in the panel | Yes | No, chat only |
| Run JavaScript on a page | Yes, even on pages with a strict CSP | No |
| Playwright + TypeScript code mode | Yes: the agent writes one script for a whole task | No |
| Model | Claude Code models (Opus, Sonnet, Haiku), on your own plan | Gemini only |
| Source | Open, MIT | Closed |

*Gemini details are from Google's 2026 announcements and press coverage. Availability changes, so check what is offered in your region.*

## What you can ask

- "Compare the prices in my three open shop tabs and tell me which is cheapest."
- "Fill this form with my details from the other tab."
- "Pause the music, then close every YouTube tab except the one I'm on."
- "Read this article and write the summary into the Google Doc I have open."
- "Go through the first 20 results on this page and list the ones under $50."

"This page" or "this tab" means the active tab in the focused window.

## What the agent can do

The agent picks one of two modes for each task on its own.

**Quick mode** handles one simple step: a single click, a question about a page, switching tabs. It uses the tab tools below and shows no "debugging" bar.

**Code mode** handles anything bigger: several steps, loops, pages, collecting data, several tabs at once. The agent writes one **TypeScript** script, and the script calls the [Playwright MCP](https://github.com/microsoft/playwright-mcp) tools and the tab tools as typed functions:

```ts
// Written by the agent and run by Chromiagent in one call
const tabs = JSON.parse(await chrome.list_tabs({}));
await playwright.browser_tabs({ action: 'select', index: 0 });
const prices = await playwright.browser_evaluate({
  function: '() => [...document.querySelectorAll(".price")].map(p => p.textContent)',
});
const titles = await playwright.browser_run_code_unsafe({
  code: `async (page) => {
    const out = [];
    for (const href of ['https://example.com/a', 'https://example.com/b']) {
      await page.goto(href);
      out.push(await page.title());
    }
    return out;
  }`,
});
return { tabs: tabs.length, prices, titles };
```

Playwright connects to **your real, logged-in Chrome**, not to a separate browser. The extension acts as a CDP endpoint for it through `chrome.debugger`. `browser_evaluate` extracts data in one call. `browser_run_code_unsafe` runs real Playwright code (`page.goto`, `getByRole(...).click()`, `fill`, `waitForSelector`, loops).

### Tab tools

| Tool | What it does |
|---|---|
| `list_tabs` | Every open tab in every window: id, title, URL, active, playing audio |
| `activate_tab` · `open_tab` · `close_tab` | Switch, open and close tabs |
| `navigate` | Load a URL, go back or forward, reload |
| `read_page` | Page text, plus numbered buttons, links and inputs it can act on |
| `click` · `type` · `scroll` | Act on an element by its number or a CSS selector |
| `press_key` | Real key presses: Enter, Escape, Tab, arrow keys… |
| `run_js` | Run JavaScript in the page and return the result |
| `screenshot` | An image of any tab |


## How it works

![How it works](docs/how.png)

- **`extension/`** is the Chrome extension: the side panel, a terminal (xterm.js), and a bridge that runs the agent's tool calls through `chrome.tabs`, `chrome.scripting` and `chrome.debugger`.
- **`host/server.js`** is a small local server on `127.0.0.1:17371`. It gives the panel a real shell (node-pty) and passes tool calls between the agent and the panel. It starts automatically at login.
- **`host/agent.sh`** starts Claude Code with only two tool servers: the tab tools (`host/mcp.js`) and code mode (`host/codemode.js`, which runs Playwright MCP).
- **One panel, one browser.** Every panel has its own id. The agent started in a panel only ever drives the browser that panel is open in.

## Safety

- **Chrome only.** In the panel, Claude Code's own shell and file tools are switched off and other MCP servers are not loaded. `file://` pages cannot be opened or read.
- **Sandboxed code mode.** Code mode and Playwright run inside a macOS sandbox (`sandbox-exec`) that blocks reading and writing your home folder. Scripts, including `browser_run_code_unsafe`, cannot touch your files, even if they reach Node's `fs` or start a process.
- **Local only.** The host listens on `127.0.0.1`, and it accepts the terminal and bridge only from this extension's ID. Websites cannot connect to it.
- **It acts as you.** The agent uses your logged-in Chrome sessions. Watch what it does and use `Ctrl+C` to stop it. Code mode, `run_js` and `press_key` show Chrome's "is debugging this browser" bar while they are attached.

## Update / uninstall

```bash
# update: run the installer again
curl -fsSL https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.sh | bash

# uninstall: then remove the extension in chrome://extensions
curl -fsSL https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.sh | bash -s -- --uninstall
```

## Troubleshooting

- **"Host not reachable" in the panel:** run the installer again, then check `/tmp/chromiagent.log`.
- **`claude: command not found`:** install Claude Code and sign in once by running `claude` in Terminal.
- **The panel opens but the agent can't see tabs:** close and reopen the panel. The bridge connects when the panel opens.

## O'zbekcha

Chromiagent: Chrome yon panelidagi terminal. Undagi AI agent barcha ochiq tablarni ko'radi va boshqaradi: o'qiydi, bosadi, yozadi, JS ishlatadi, skrinshot oladi. Murakkab vazifalarda agent o'zi TypeScript code mode'ga o'tadi: Playwright (`browser_evaluate`, `browser_run_code_unsafe`) sizning ochiq Chrome'ingizda ishlaydi. O'rnatish uchun yuqoridagi buyruqni Terminal'da ishga tushiring, keyin `chrome://extensions` → Developer mode → Load unpacked → pin. Panel `Alt+A` bilan ochiladi. Agent faqat Chrome ichida ishlaydi va kompyuterdagi fayllarga tegmaydi.

---

**Author: SvRvS** · [MIT License](LICENSE)
