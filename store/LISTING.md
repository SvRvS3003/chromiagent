# Chrome Web Store listing — Chromiagent

## Short description (manifest description, 105 characters)

Side-panel terminal that drives the page you assign to with a human, curved cursor — one task, one script, no per-step approvals.

## Category

Developer Tools (Productivity is the alternate category.)

## Full description

Chromiagent puts a real terminal in Chrome's side panel. You type a task in plain words; the agent
reads the page you gave it, clicks, fills and navigates with a pointer that moves in tremoring arcs,
the way a hand does. It keeps working on that page while you browse elsewhere, and it never pulls
your focus away.

**Setup (two parts)**

1. Install this extension.
2. In Terminal, run:
   `curl -fsSL https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.sh | bash`
   Node.js 22.13+ and one terminal CLI are required; the installer tells you which one is missing.
3. Press `Alt+A`, open the page you want handled, and type the task.

The extension is the panel; the local app it connects to does the work. Both are open source:
`github.com/SvRvS3003/chromiagent`.

**What you can do**

- List tabs, read a page, click, type, scroll, press keys and take screenshots on the assigned page.
- Give one complete task as a single script instead of approving every small step.
- Pick any element on a page and send it to the terminal with your note.
- Watch a changing page and act on what appears.
- Keep the work on one page: switching tabs, windows or apps does not disturb it.

**Privacy**

Everything stays on your machine. The panel talks only to the local app at `127.0.0.1:17371`;
there is no analytics, no remote endpoint and no account. See the privacy policy on this listing.

## Single purpose

Provide a terminal in Chrome's side panel whose commands can read and operate the page the user assigns to it.

## Permission justifications (Privacy tab → Permissions)

| Permission | Justification for the reviewer |
|---|---|
| `sidePanel` | The terminal lives in the browser side panel; this permission draws it next to the page. |
| `tabs` | The user picks which open page the terminal works on; the panel lists tab titles and URLs and resolves the active page. |
| `tabGroups` | Older builds placed the agent's own tabs in a group; this permission lets the new build remove those leftover groups. No group is created anymore. |
| `scripting` | The pointer, question cards, page reader and element picker are injected into the assigned page with `chrome.scripting`. |
| `debugger` | Only for user-initiated browser inspection: a CDP relay lets the local app inspect the assigned tab and capture screenshots of a tab that is not in front. No debugger session is attached on the ordinary path, and no browsing history is collected. |
| `storage` | Remembers the panel id, the work page bound to the current job, and the chosen terminal name in this browser. |
| `<all_urls>` | The user may assign any web page, including local intranet pages; page access is required to read and operate it. |
| CSP `connect-src ws://127.0.0.1:17371` | Connects to the companion app the user installs on the same machine. No external host is contacted. |

## Data-use declaration (Privacy tab → Data usage)

- **Data collected:** page content of the assigned tab, tab titles and URLs, and text the user types into the panel or feedback card.
- **Where it goes:** only to the local companion app on `127.0.0.1`, then to the terminal program the user installed. The extension itself uploads nothing.
- **Retention:** in browser session storage for the current browser session; local host session state lives under `~/.chromiagent` until the user removes it.
- **No third-party sharing, no sale, no advertising, no analytics, no remote code.**

## Test instructions (for the reviewer)

1. In Terminal: `curl -fsSL https://raw.githubusercontent.com/SvRvS3003/chromiagent/main/install.sh | bash` (needs Node.js 22.13+ and an installed terminal CLI).
2. Open any public web page, press `Alt+A` to open the panel.
3. Type: "read the title of this page and report it". The panel should show the agent reading the page and answering in the terminal.
4. Click the picker icon in the panel header, click an element, type a note and press `Ctrl+Enter` — the note appears in the terminal.
5. If Chrome asks about the debugger banner: it appears only while the inspector/screenshot tool runs, and disappears when it detaches.

## Privacy policy URL

`https://github.com/SvRvS3003/chromiagent/blob/main/store/PRIVACY.md`

## Screenshots

`store/screenshots/1-terminal.png`, `2-cursor.png`, `3-picker.png` — 1280 x 800 PNG.
