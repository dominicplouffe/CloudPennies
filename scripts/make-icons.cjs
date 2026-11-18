// Requires Playwright (dev-only; not a project dependency): npm i -g playwright
// Renders public/logo.svg into the PNG icons electron-builder needs.
const { chromium } = require('playwright');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');

(async () => {

const svg = readFileSync('public/logo.svg', 'utf8');
mkdirSync('build/icons', { recursive: true });
const browser = await chromium.launch();
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const png = await page.screenshot({ omitBackground: true });
  writeFileSync(`build/icons/${size}x${size}.png`, png);
  if (size === 1024) writeFileSync('build/icon.png', png);
  await page.close();
}
await browser.close();
console.log('icons written to build/');
})();
