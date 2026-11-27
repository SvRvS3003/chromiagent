// The helpers prepended to every code-mode script must parse and work: view() reads a full page
// snapshot, refFor() finds a numbered element by label — including shadow/frame paths.
const fs = require('fs');
const path = require('path');
const { stripTypeScriptTypes } = require('node:module');

const LIBRARY = ['observe.ts', 'chess.ts'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'host', f), 'utf8')).join('\n');
const code = `${LIBRARY}
const v = await view(42);
return { title: v.title, ref: refFor(v, 'Shadow button'), missing: refFor(v, 'Nothing here'), overlays: v.overlays };
`;

(async () => {
  const js = stripTypeScriptTypes(`async function __main(chrome, playwright, engine, console) {\n${code}\n}`, { mode: 'strip' });
  const main = new Function(`${js}\nreturn __main;`)();
  const chrome = {
    read_page: async ({ tabId, maxChars }) => {
      if (tabId !== 42) throw new Error('wrong tab');
      return JSON.stringify({ title: 'Page', url: 'https://x.test', text: '', overlays: 'dialog "Confirm"', selects: '', frames: '', shadows: '', elements: '[0] button "Open"\n[2] shadow#host > button "Shadow button"' });
    },
  };
  const out = await main(chrome, {}, {}, console);
  const ok = out.title === 'Page' && out.ref === 2 && out.missing === null && /Confirm/.test(out.overlays);
  console.log(ok ? 'PASS  view()/refFor() available in code mode' : `FAIL  ${JSON.stringify(out)}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
