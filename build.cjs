const fs = require("node:fs"),
  path = require("node:path"),
  esbuild = require("esbuild");
(async () => {
  const out = path.join(__dirname, "docs");
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, "main.mjs")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: path.join(out, "main.js"),
    loader: { ".html": "text" },
    legalComments: "eof",
  });
  for (const name of [
    "index.html",
    "style.css",
    "fonts.css",
    "cloud.css",
    "activity.css",
    "SHORTCUTS.md",
    "dmsans-LICENSE.txt",
    "manrope-LICENSE.txt",
  ])
    fs.copyFileSync(path.join(__dirname, name), path.join(out, name));
  fs.writeFileSync(path.join(out, ".nojekyll"), "");
  console.log("Built docs/ for GitHub Pages.");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
