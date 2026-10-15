// Renders the dashboard bundle in headless Chromium with VS Code theme colours and sample state; writes PNGs to
// test/visual/out/ (and README images to media/screenshots/ with --readme). Run: npm run screenshots
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { dashboardState } = require("../fixtures");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "out");
const README_DIR = path.join(ROOT, "media", "screenshots");
const writeReadme = process.argv.includes("--readme");

const base = {
  "font-family": '"Segoe UI", system-ui, sans-serif',
  "font-size": "13px",
  "editor-font-family": 'Consolas, "Courier New", monospace',
};
const THEMES = {
  dark: {
    "editor-background": "#1f1f1f", foreground: "#cccccc", descriptionForeground: "#9d9d9d", "panel-border": "#2b2b2b", "widget-border": "#313131",
    "sideBar-background": "#181818", "editorWidget-background": "#202020", "list-hoverBackground": "#2a2d2e", focusBorder: "#0078d4",
    "testing-iconPassed": "#73c991", "testing-iconFailed": "#f14c4c", "editorWarning-foreground": "#cca700", "textLink-foreground": "#4daafc",
    "badge-background": "#616161", "badge-foreground": "#f8f8f8", "button-background": "#0078d4", "button-foreground": "#ffffff",
    "button-hoverBackground": "#026ec1", "button-secondaryBackground": "#313131", "button-secondaryForeground": "#cccccc",
    "button-secondaryHoverBackground": "#3c3c3c", "button-border": "#ffffff12", "input-background": "#313131", "input-foreground": "#cccccc",
    "input-border": "#3c3c3c", "dropdown-background": "#313131", "dropdown-foreground": "#cccccc", "dropdown-border": "#3c3c3c",
    "progressBar-background": "#0078d4", "toolbar-hoverBackground": "#5a5d5e50", "toolbar-activeBackground": "#63666750",
    "charts-blue": "#3794ff", "charts-purple": "#b180d7", "charts-orange": "#d18616", "charts-green": "#89d185",
    "charts-yellow": "#cca700", "charts-red": "#f14c4c", "list-inactiveSelectionBackground": "#37373d", "list-activeSelectionForeground": "#ffffff",
    "menu-background": "#1f1f1f", "menu-foreground": "#cccccc", "menu-border": "#454545", "menu-selectionBackground": "#0078d4", "menu-selectionForeground": "#ffffff", "menu-separatorBackground": "#454545",
    "notifications-background": "#1f1f1f", "notifications-foreground": "#cccccc", "notifications-border": "#2b2b2b",
    "scrollbarSlider-background": "#79797966", "scrollbarSlider-hoverBackground": "#646464b3", "inputValidation-errorBorder": "#be1100",
  },
  light: {
    "editor-background": "#ffffff", foreground: "#3b3b3b", descriptionForeground: "#717171", "panel-border": "#e5e5e5", "widget-border": "#e5e5e5",
    "sideBar-background": "#f8f8f8", "editorWidget-background": "#f8f8f8", "list-hoverBackground": "#f2f2f2", focusBorder: "#005fb8",
    "testing-iconPassed": "#388a34", "testing-iconFailed": "#e51400", "editorWarning-foreground": "#bf8803", "textLink-foreground": "#005fb8",
    "badge-background": "#cccccc", "badge-foreground": "#3b3b3b", "button-background": "#005fb8", "button-foreground": "#ffffff",
    "button-hoverBackground": "#0258a8", "button-secondaryBackground": "#e5e5e5", "button-secondaryForeground": "#3b3b3b",
    "button-secondaryHoverBackground": "#cccccc", "button-border": "#0000001a", "input-background": "#ffffff", "input-foreground": "#3b3b3b",
    "input-border": "#cecece", "dropdown-background": "#ffffff", "dropdown-foreground": "#3b3b3b", "dropdown-border": "#cecece",
    "progressBar-background": "#005fb8", "toolbar-hoverBackground": "#b8b8b850", "toolbar-activeBackground": "#a6a6a650",
    "charts-blue": "#1a85ff", "charts-purple": "#652d90", "charts-orange": "#d18616", "charts-green": "#388a34",
    "charts-yellow": "#bf8803", "charts-red": "#e51400", "list-inactiveSelectionBackground": "#e4e6f1", "list-activeSelectionForeground": "#000000",
    "menu-background": "#ffffff", "menu-foreground": "#3b3b3b", "menu-border": "#cecece", "menu-selectionBackground": "#005fb8", "menu-selectionForeground": "#ffffff", "menu-separatorBackground": "#e5e5e5",
    "notifications-background": "#ffffff", "notifications-foreground": "#3b3b3b", "notifications-border": "#e5e5e5",
    "scrollbarSlider-background": "#64646466", "scrollbarSlider-hoverBackground": "#646464b3", "inputValidation-errorBorder": "#be1100",
  },
  "high-contrast": {
    "editor-background": "#000000", foreground: "#ffffff", descriptionForeground: "#ffffffb3", "panel-border": "#6fc3df", "widget-border": "#6fc3df",
    "sideBar-background": "#000000", "editorWidget-background": "#0c141f", "list-hoverBackground": "#00000000", focusBorder: "#f38518",
    "testing-iconPassed": "#73c991", "testing-iconFailed": "#f48771", "editorWarning-foreground": "#ffd370", "textLink-foreground": "#21a6ff",
    "badge-background": "#000000", "badge-foreground": "#ffffff", "button-background": "#000000", "button-foreground": "#ffffff",
    "button-hoverBackground": "#000000", "button-secondaryBackground": "#000000", "button-secondaryForeground": "#ffffff",
    "button-secondaryHoverBackground": "#000000", "button-border": "#6fc3df", "input-background": "#000000", "input-foreground": "#ffffff",
    "input-border": "#6fc3df", "dropdown-background": "#000000", "dropdown-foreground": "#ffffff", "dropdown-border": "#6fc3df",
    "progressBar-background": "#6fc3df", "toolbar-hoverBackground": "#00000000", "toolbar-activeBackground": "#00000000",
    "charts-blue": "#3794ff", "charts-purple": "#b180d7", "charts-orange": "#d18616", "charts-green": "#89d185",
    "charts-yellow": "#ffd370", "charts-red": "#f48771", "list-inactiveSelectionBackground": "#00000000", "list-activeSelectionForeground": "#ffffff",
    "menu-background": "#000000", "menu-foreground": "#ffffff", "menu-border": "#6fc3df", "menu-selectionBackground": "#000000", "menu-selectionForeground": "#ffffff", "menu-separatorBackground": "#6fc3df",
    "notifications-background": "#000000", "notifications-foreground": "#ffffff", "notifications-border": "#6fc3df",
    "scrollbarSlider-background": "#6fc3df99", "scrollbarSlider-hoverBackground": "#6fc3dfcc", "inputValidation-errorBorder": "#f38518",
  },
};

const TABS = ["overview", "models", "combos", "providers", "usage", "settings"];

function page(theme) {
  const vars = Object.entries({ ...base, ...THEMES[theme] }).map(([k, v]) => `--vscode-${k}: ${v};`).join("\n");
  const css = (f) => fs.readFileSync(path.join(ROOT, "media", f), "utf8");
  const codicons = css("codicon.css").replace(/url\("\.\/codicon\.ttf[^"]*"\)/, `url("data:font/ttf;base64,${fs.readFileSync(path.join(ROOT, "media", "codicon.ttf")).toString("base64")}")`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>:root{${vars}}</style><style>${codicons}</style><style>${css("dashboard.css")}</style></head>
<body class="vscode-${theme === "high-contrast" ? "high-contrast" : theme}"><div id="app"></div>
<script>window.acquireVsCodeApi = () => ({ postMessage: (m) => (window.__sent = (window.__sent || []).concat([m])), getState: () => undefined, setState: () => {} });</script>
<script>${css("dashboard.js")}</script></body></html>`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (writeReadme) fs.mkdirSync(README_DIR, { recursive: true });
  const browser = await chromium.launch();
  let count = 0;
  for (const theme of Object.keys(THEMES)) {
    for (const [name, width, height] of [["wide", 1280, 800], ["narrow", 640, 900]]) {
      const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      const errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      await p.setContent(page(theme));
      await p.evaluate((state) => window.postMessage({ type: "state", state }, "*"), dashboardState());
      const shot = async (label) => {
        const file = path.join(OUT, `${theme}-${name}-${label}.png`);
        await p.screenshot({ path: file });
        count++;
        if (writeReadme && theme === "dark" && name === "wide") fs.copyFileSync(file, path.join(README_DIR, `${label}.png`));
      };
      for (const tab of TABS) {
        await p.click(`[data-tab="${tab}"]`);
        await p.waitForTimeout(100);
        await shot(tab);
      }
      await p.click('[data-tab="combos"]');
      await p.click('#pageActions [data-action="new-combo"]');
      await p.fill("#c-name", "smart");
      for (const id of ["anthropic/claude-sonnet-5-5", "openai/gpt-5.4"]) {
        await p.fill("#c-add", id);
        await p.press("#c-add", "Enter");
      }
      await shot("combo-form");
      for (const [label, snap] of [["offline", { state: "offline" }], ["needs-key", { state: "needsKey", error: "HTTP 401: Invalid API key" }]]) {
        await p.evaluate((state) => window.postMessage({ type: "state", state }, "*"), dashboardState({ snap }));
        await p.click('[data-tab="overview"]');
        await shot(label);
      }
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) errors.push(`horizontal overflow at ${width}px`);
      if (errors.length) console.log(`${theme}/${name}: ${errors.join(" | ")}`);
      await p.close();
    }
  }
  await browser.close();
  console.log(`wrote ${count} screenshots to ${path.relative(ROOT, OUT)}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
