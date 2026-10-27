// Inline src/ into a single self-contained index.html (GitHub Pages + Claude artifact).
import { readFileSync, writeFileSync } from 'fs';
const r = (f) => readFileSync(new URL('./src/' + f, import.meta.url), 'utf8');
let html = r('index.template.html');
const parts = { STYLE: r('style.css'), DSP: r('space.js') + '\n' + r('modal.js'), STRUM: r('strum.js'), APP: r('app.js') };
for (const [k, v] of Object.entries(parts)) {
  if (v.includes('</script')) throw new Error(k + ' contains </script');
  html = html.replace(`/*@@${k}@@*/`, () => v);
}
writeFileSync(new URL('./dist/artifact.html', import.meta.url), html);
// standalone page for GitHub Pages: add a doctype/head shell
const page = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${html}\n</body>\n</html>\n`;
writeFileSync(new URL('./index.html', import.meta.url), page);
console.log('built', (html.length / 1024).toFixed(1) + ' KB');
