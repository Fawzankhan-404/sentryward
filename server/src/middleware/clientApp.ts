import path from "node:path";
import express, { Router } from "express";

// Serves the built client from the API so the production image needs no
// separate web server. Mounted after the API routers, so unknown /api paths
// still reach the JSON 404.
export function clientApp(dir: string): Router {
  const router = Router();
  const index = path.resolve(dir, "index.html");

  router.use(
    express.static(dir, {
      index: false,
      setHeaders(res, filePath) {
        // Vite fingerprints everything under assets/, so those never change.
        if (filePath.startsWith(path.resolve(dir, "assets") + path.sep)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );

  // Client-side routes such as /reviews/:id must load the app on a full reload.
  // API calls fall through to the JSON 404, and so do missing assets: a chunk
  // from an older deploy must fail as a 404, not parse index.html as script.
  router.get(/^(?!\/(?:api|assets)(?:\/|$)).*/, (req, res, next) => {
    if (!req.accepts("html")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(index);
  });

  return router;
}
