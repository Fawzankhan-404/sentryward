import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { clientApp } from "../src/middleware/clientApp.ts";

// A stand-in for client/dist, mounted the way app.ts mounts it: after an API
// router and before the JSON 404.
const dist = mkdtempSync(path.join(tmpdir(), "sentryward-dist-"));
mkdirSync(path.join(dist, "assets"));
writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>Sentryward</title>");
writeFileSync(path.join(dist, "assets", "index-abc123.js"), "console.log(1)");
writeFileSync(path.join(dist, "favicon.ico"), "icon");

const app = express();
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use(clientApp(dist));
app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

describe("clientApp", () => {
  it("serves index.html at the root without caching", async () => {
    const res = await request(app).get("/").set("Accept", "text/html").expect(200);
    expect(res.text).toContain("<title>Sentryward</title>");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves index.html for client-side routes", async () => {
    const res = await request(app).get("/reviews/abc").set("Accept", "text/html").expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("<title>Sentryward</title>");
  });

  it("caches fingerprinted assets permanently", async () => {
    const res = await request(app).get("/assets/index-abc123.js").expect(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("revalidates other static files", async () => {
    const res = await request(app).get("/favicon.ico").expect(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("answers a missing asset with 404 instead of index.html", async () => {
    const res = await request(app).get("/assets/index-old.js").set("Accept", "*/*").expect(404);
    expect(res.body).toEqual({ message: "Not found" });
  });

  it("leaves API routes and unknown API paths to the API", async () => {
    await request(app).get("/api/health").expect(200, { status: "ok" });
    const res = await request(app).get("/api/missing").set("Accept", "text/html").expect(404);
    expect(res.body).toEqual({ message: "Not found" });
  });

  it("does not answer non-HTML or non-GET requests with the app", async () => {
    await request(app).get("/reviews/abc").set("Accept", "application/json").expect(404);
    await request(app).post("/reviews/abc").set("Accept", "text/html").expect(404);
  });
});
