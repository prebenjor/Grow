const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function safeFilePath(urlPath) {
  const cleanPath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT_DIR, cleanPath);
  return filePath.startsWith(ROOT_DIR) ? filePath : null;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed");
    return;
  }

  const filePath = safeFilePath(req.url.split("?")[0]);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Grow listening on http://localhost:${PORT}`);
});
