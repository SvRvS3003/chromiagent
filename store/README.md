# Publishing Chromiagent to the Chrome Web Store

The ZIP in this folder is ready to upload. The browser side installs from the store; the local host
still needs the installer, so the listing explains both steps.

## Before uploading

1. Register a Chrome Web Store developer account at https://chrome.google.com/webstore/devconsole
   (one-time registration fee; Uzbekistan is a supported country).
2. Open `LISTING.md`: short description, full description, single purpose, permission justifications,
   data-use declarations, test instructions and privacy URL are all written out.
3. Use `PRIVACY.md` as the public privacy-policy URL (the GitHub link works as-is).
4. Choose **unlisted** distribution if you only want people with the link to install it. Review still
   applies, but the item does not appear in store search.

## Upload

Developer Dashboard → **Add new item** → choose `store/chromiagent-<version>.zip` → fill the tabs from
`LISTING.md` → **Submit for Review**. Each new version needs a higher `version` in
`extension/manifest.json`.

## After the store build is live

A store extension has its own id, different from the unpacked `lagobfbebmgoaemfkbnmeljdfagpaefj`.
Read the new id from `chrome://extensions` (Developer mode on) and add the 32-letter id, one per line,
to:

```
~/.chromiagent/extra-origins
```

Then restart the local host:

```bash
launchctl kickstart -k gui/$(id -u)/uz.svrvs.chromiagent
```

Without this step the store build opens the panel but cannot reach the local bridge.

## Rebuilding the ZIP for a new version

```bash
cd extension && zip -r ../store/chromiagent-<version>.zip . && cd ..
```

`manifest.json` must be at the root of the ZIP, not inside a folder.

## Review risks to expect

- `debugger` and `<all_urls>` are broad permissions. The justifications in `LISTING.md` explain the
  narrow, user-initiated use; if the reviewer asks for changes, the fallback is to drop `cdp.js`,
  the debug-based screenshot path and the `debugger` permission from the store package only.
- The panel needs a locally installed companion app. The listing states this upfront and the panel
  shows a clear error when the host is missing.
- The manifest embeds a `key` to keep the unpacked id stable. If the dashboard rejects it, remove the
  `key` field from the store ZIP only; the local host accepts the resulting store id via
  `extra-origins`.

## Screenshots

1280 x 800 PNGs generated from `docs/` with `sips` live in `store/screenshots/`.
