// Renders media/icon.png (128×128 Marketplace icon) from inline SVG with Playwright: node test/visual/icon.js
const path = require("path");
const { chromium } = require("playwright");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#1f8bff"/></linearGradient></defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round">
    <circle cx="64" cy="64" r="14"/>
    <path d="M64 18v26M64 84v26M18 64h26M84 64h26"/>
    <path d="M34 34l18 18M76 76l18 18M94 34L76 52M52 76L34 94" opacity="0.6"/>
  </g>
  <g fill="#fff"><circle cx="64" cy="16" r="7"/><circle cx="64" cy="112" r="7"/><circle cx="16" cy="64" r="7"/><circle cx="112" cy="64" r="7"/></g>
</svg>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.screenshot({ path: path.join(__dirname, "..", "..", "media", "icon.png"), omitBackground: true });
  await browser.close();
  console.log("wrote media/icon.png");
})();
