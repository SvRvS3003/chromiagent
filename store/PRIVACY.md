# Privacy Policy — Chromiagent

Chromiagent is a terminal that lives in Chrome's side panel and works on a web page the user assigns
to it. It runs on the user's own computer. The extension does not send data to its developer or to
any remote service.

## What the extension reads

- The title, URL and visible text of the page assigned to the terminal.
- Titles and URLs of open tabs, for the tab picker.
- When the user clicks the element picker: the chosen element's tag, attributes, text, position and a
  short HTML snippet, together with the note the user writes.
- When the user asks it to watch a page: page events (clicks, typing, navigation) on that tab. The
  recorder keeps recent events in memory for that watch only.

## Where that data goes

Only to the companion app the user installs on the same machine, at `ws://127.0.0.1:17371`, and from
there to the terminal program the user chose. The extension has no analytics, no advertising, no
third-party endpoints, no account and no login. It uploads nothing.

## What it stores

- Browser session storage: the panel id, the work page bound to the current job, and the set of tabs
  the agent opened.
- Browser local storage: the name of the chosen terminal program.
- Local host: terminal session state and workspace files under `~/.chromiagent`.

## What it does not do

- It does not read pages the user has not assigned to it.
- It does not collect passwords or form secrets typed into web pages.
- It does not share data with third parties or sell it.
- It does not execute remotely hosted code; all extension code is packaged with the extension.

## Removing data

Removing the extension clears the browser-side storage. Deleting `~/.chromiagent` removes the local
host's session state and workspace.

## Contact

SvRvS — through the source repository: https://github.com/SvRvS3003/chromiagent
