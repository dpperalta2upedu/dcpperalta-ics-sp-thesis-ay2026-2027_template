import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { promises as fs } from "node:fs";
import path from "node:path";

function uiMainLayoutBackupPlugin(): Plugin {
  const targets = [
    {
      endpoint: "/api/ui-main-layout/save",
      outputPath: path.resolve(__dirname, "src/data/main_layout.json"),
      successPath: "src/data/main_layout.json",
      errorMessage: "Failed to save UI main_layout backup.",
    },
    {
      endpoint: "/api/sandbox/ui-main-layout/save",
      outputPath: path.resolve(__dirname, "sandbox/data/main_layout.json"),
      successPath: "sandbox/data/main_layout.json",
      errorMessage: "Failed to save sandbox UI main_layout backup.",
    },
  ];

  return {
    name: "ui-main-layout-backup",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        const target = targets.find((item) => item.endpoint === url);
        if (req.method !== "POST" || !target) {
          next();
          return;
        }

        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const raw = Buffer.concat(chunks).toString("utf-8");
          const payload = JSON.parse(raw);

          if (!payload || typeof payload !== "object" || !payload.floors || typeof payload.floors !== "object") {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "Invalid map layout payload." }));
            return;
          }

          await fs.mkdir(path.dirname(target.outputPath), { recursive: true });
          await fs.writeFile(target.outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, path: target.successPath }));
        } catch {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: target.errorMessage }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), uiMainLayoutBackupPlugin()],
  server: {
    proxy: {
      "/api/sandbox": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/api/auth": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/api/search": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/api/map-layout": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/api/map-layout-history": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/api/draft-maps": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
