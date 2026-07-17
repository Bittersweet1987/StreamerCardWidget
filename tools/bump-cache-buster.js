// Bumps the shared cache-buster query string ("?v=...") used everywhere in public/ - every
// <script>/<link> tag AND every internal ES module import ("from './api.js?v=...'") - to a new
// value, all in one shot. This exists because OBS/Meld browser sources cache extremely
// aggressively (they're a persistent embedded browser tab, not a page that re-navigates on every
// scene switch - see CLAUDE.md's "OBS cacht Overlays hart" gotcha) and ignore Cache-Control:
// no-store in practice. Bumping cache-busters file-by-file by hand is exactly how a stale
// api.js/render.js import went unnoticed and caused every overlay to go blank (2026-07-16) - this
// script replaces that manual process so EVERY reference always moves together.
//
// Usage:  node tools/bump-cache-buster.js <new-value>
// Example: node tools/bump-cache-buster.js 20260717-fix1
//
// After running, still: sync public/ into CardPackWidget-TestApp/ and dist/CardPackWidgetApp/,
// and tell the user to "Cache aktualisieren" on each OBS/Meld source once (a changed source URL
// alone doesn't retroactively refresh a browser source that's already open).

const fs = require("fs");
const path = require("path");

const newValue = process.argv[2];
if (!newValue) {
  console.error("Usage: node tools/bump-cache-buster.js <new-value>");
  process.exit(1);
}

const publicDir = path.join(__dirname, "..", "public");
const targetExtensions = [".html", ".js"];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (targetExtensions.includes(path.extname(entry.name))) files.push(full);
  }
  return files;
}

// Matches ?v=<anything-not-quote-or-whitespace> after .js/.css references. Excludes "$" so the
// runtime-versioned dynamic imports (`./api.js?v=${__v}`) in the overlay entry modules are left
// alone - their version comes from the server's BootId at runtime, not from this script.
const versionedRefRegex = /(\.(?:js|css)\?v=)[^"'\s)$]+/g;
// Matches an internal ES module import of api.js/render.js that has NO "?v=" yet.
const unversionedImportRegex = /(from\s+["'])(\.\/(?:api|render)\.js)(["'])/g;

let changedFiles = 0;
let totalReplacements = 0;

for (const file of walk(publicDir)) {
  let content = fs.readFileSync(file, "utf8");
  let replacements = 0;

  content = content.replace(versionedRefRegex, (match, prefix) => {
    replacements++;
    return prefix + newValue;
  });

  content = content.replace(unversionedImportRegex, (match, before, module_, after) => {
    replacements++;
    return `${before}${module_}?v=${newValue}${after}`;
  });

  if (replacements > 0) {
    fs.writeFileSync(file, content, "utf8");
    changedFiles++;
    totalReplacements += replacements;
    console.log(`${path.relative(publicDir, file)}: ${replacements} reference(s)`);
  }
}

console.log(`\nDone: ${totalReplacements} reference(s) across ${changedFiles} file(s) now use "${newValue}".`);
