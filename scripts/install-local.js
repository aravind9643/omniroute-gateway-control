// Builds a VSIX and sideloads it into VS Code, for trying the extension in a real editor.
// Usage: npm run install:insiders [-- --stable] [-- --keep]
//   --stable  install into VS Code Stable (`code`) instead of Insiders (`code-insiders`)
//   --keep    leave the .vsix behind instead of deleting it
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const args = process.argv.slice(2);
const stable = args.includes("--stable");
const keep = args.includes("--keep");
const cli = stable ? "code" : "code-insiders";
const target = stable ? "VS Code" : "VS Code Insiders";

/**
 * Runs a command through a shell, which is required for VS Code's CLI on Windows (a .cmd shim).
 * The whole command is one string: passing an args array alongside shell:true is deprecated (DEP0190).
 */
function sh(command, { capture = false } = {}) {
  const res = spawnSync(command, { shell: true, encoding: "utf8", stdio: capture ? "pipe" : "inherit", cwd: root });
  if (res.error) throw res.error;
  return { status: res.status ?? 1, out: `${res.stdout || ""}${res.stderr || ""}` };
}

const quote = (p) => `"${p}"`;

if (sh(`${cli} --version`, { capture: true }).status !== 0) {
  console.error(`\n✖ "${cli}" is not on your PATH, so ${target} cannot be reached.`);
  console.error(
    stable
      ? "  In VS Code run: Shell Command: Install 'code' command in PATH"
      : "  In VS Code Insiders run: Shell Command: Install 'code-insiders' command in PATH"
  );
  console.error("  Or install the .vsix by hand: Extensions view → ⋯ → Install from VSIX…\n");
  process.exit(1);
}

const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
console.log(`\n▸ Packaging ${pkg.name} ${pkg.version}…`);
// vsce runs vscode:prepublish, which typechecks and bundles, so no separate build step is needed.
if (sh(`npx vsce package --no-dependencies --out ${quote(vsix)}`).status !== 0) {
  console.error("\n✖ Packaging failed.\n");
  process.exit(1);
}

// An older build under a different id would register the same chat vendor and compete with this one.
const STALE_IDS = ["aravindmerugu.omniroute-vscode"];
const installed = sh(`${cli} --list-extensions`, { capture: true }).out.toLowerCase();
for (const id of STALE_IDS) {
  if (installed.includes(id)) {
    console.log(`▸ Removing the superseded ${id}…`);
    sh(`${cli} --uninstall-extension ${id}`);
  }
}

console.log(`▸ Installing into ${target}…`);
const ok = sh(`${cli} --install-extension ${quote(vsix)} --force`).status === 0;
if (!keep) fs.rmSync(vsix, { force: true });

if (!ok) {
  console.error("\n✖ Install failed.\n");
  process.exit(1);
}

// Both extensions register the `omniroute` chat vendor, so models would appear twice.
if (installed.includes("diegosouzapw.omnicopilot")) {
  console.log("\n! diegosouzapw.omnicopilot is also installed; both serve OmniRoute models to Copilot,");
  console.log("  so expect duplicates in the model picker. Disable one if that gets confusing.");
}

console.log(`\n✔ Installed ${pkg.name} ${pkg.version} into ${target}.`);
console.log(`  Reload it to activate: Developer: Reload Window${keep ? `\n  Kept ${path.basename(vsix)}` : ""}\n`);
