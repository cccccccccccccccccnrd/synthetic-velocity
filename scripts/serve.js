import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Minimal static file server (no directory listing). Resolves once listening;
 * the returned server can be closed with `server.close()`.
 */
export function serveDir(root, host, port) {
  const fsRoot = resolve(root);

  const server = createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      let filePath = resolve(join(fsRoot, decodeURIComponent(pathname)));
      if (filePath !== fsRoot && !filePath.startsWith(fsRoot + sep)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      let info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) {
        filePath = join(filePath, "index.html");
        info = await stat(filePath).catch(() => null);
      }
      if (!info?.isFile()) {
        response.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
        return;
      }
      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(filePath).toLowerCase()] ??
          "application/octet-stream",
        "content-length": info.size,
        "cache-control": "no-cache",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(400).end("Bad Request");
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}
