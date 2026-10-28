const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path");
const root = path.join(__dirname, "docs");
http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    if (!u.pathname.startsWith("/saldo-budget/")) {
      res.writeHead(404).end();
      return;
    }
    let target;
    try {
      target = path.resolve(
        root,
        decodeURIComponent(
          u.pathname.slice("/saldo-budget/".length) || "index.html",
        ),
      );
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!target.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".mjs": "text/javascript",
            ".css": "text/css",
            ".json": "application/json",
          }[path.extname(target)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  })
  .listen(5175, "127.0.0.1", () =>
    console.log("http://127.0.0.1:5175/saldo-budget/"),
  );
