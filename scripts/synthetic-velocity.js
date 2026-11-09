#!/usr/bin/env node

/**
 * synthetic velocity pipeline.
 *
 * This repo owns the artwork. External repositories are source material:
 * source repo HTML/SVG → extracted 2D forms → hosted iframe → 3D pipes → shader.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveDir } from "./serve.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_DIR = join(ROOT, "in");
const SITE_DIR = join(ROOT, "site");
const CLIENT_DIR = join(ROOT, "src", "client");

const SOURCES = [
  {
    id: "diagram-design",
    repoUrl: "https://github.com/cathrynlavery/diagram-design.git",
    branch: "main",
    assetPath: "skills/diagram-design/assets",
    include: /^example.*\.html$|^index\.html$/,
  },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function run(command, cwd = ROOT) {
  console.log("$", command.join(" "));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`command failed: ${command.join(" ")}`))
    );
  });
}

async function ensureSource(source, noFetch) {
  const repoDir = join(INPUT_DIR, source.id, "repo");
  if (noFetch && await exists(join(repoDir, source.assetPath))) return repoDir;

  await mkdir(dirname(repoDir), { recursive: true });
  if (!await exists(join(repoDir, ".git"))) {
    if (await exists(repoDir)) await rm(repoDir, { recursive: true });
    await run([
      "git",
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "--sparse",
      "--branch",
      source.branch,
      source.repoUrl,
      repoDir,
    ]);
  }

  await run(["git", "sparse-checkout", "set", source.assetPath], repoDir);
  if (!noFetch) {
    await run(["git", "fetch", "--depth=1", "origin", source.branch], repoDir);
    await run(["git", "reset", "--hard", "FETCH_HEAD"], repoDir);
    await run(["git", "clean", "-fd", source.assetPath], repoDir);
  }
  return repoDir;
}

async function copyDirFiltered(sourceDir, outDir, include) {
  await mkdir(outDir, { recursive: true });
  const copied = [];
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !include.test(entry.name)) continue;
    await copyFile(join(sourceDir, entry.name), join(outDir, entry.name));
    copied.push(entry.name);
  }
  copied.sort();
  return copied;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  ).replaceAll('"', "&quot;");
}

async function writeHostIndex(documents) {
  const sourceDocuments = documents.filter((doc) => doc !== "index.html");
  const options = sourceDocuments
    .map((doc) =>
      `<option value="sources/diagram-design/${escapeHtml(doc)}">${
        escapeHtml(doc)
      }</option>`
    )
    .join("\n");

  await writeFile(
    join(SITE_DIR, "index.html"),
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>synthetic velocity</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; touch-action: none; overscroll-behavior: none; }
    #preview { position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; opacity: 0; pointer-events: none; }
    .abstract-shader-canvas { position: fixed !important; inset: 0 !important; z-index: 5 !important; width: 100vw !important; height: 100vh !important; display: block !important; background: #000 !important; }
    .nav-zone { position: fixed; top: 0; bottom: 0; z-index: 70; width: 50vw; border: 0; padding: 0; margin: 0; background: transparent; cursor: pointer; touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; outline: none; }
    .nav-zone.left { left: 0; }
    .nav-zone.right { right: 0; }
    .abstract-control-panel {
      position: fixed; right: 10px; top: 10px; z-index: 100;
      width: min(320px, calc(100vw - 20px));
      border: 1px solid rgba(255,255,255,.22); border-radius: 10px;
      background: rgba(0,0,0,.96); color: #fff;
      font: 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: .08em; text-transform: uppercase;
    }
    .abstract-control-panel[data-force-hidden="true"] { display: none !important; }
    .abstract-control-panel[data-force-hidden="false"] { display: block !important; }
    .abstract-control-panel[data-control-mode="normal"] .abstract-control-row[data-control-tier="advanced"] { display: none !important; }
    .abstract-control-panel summary { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; cursor: pointer; user-select: none; }
    .abstract-control-body { display: grid; gap: 8px; max-height: calc(100vh - 70px); overflow: auto; padding: 0 10px 10px; }
    .abstract-control-row { display: grid; grid-template-columns: 112px minmax(0, 1fr) 44px; align-items: center; gap: 8px; min-height: 22px; }
    .abstract-control-row output { text-align: right; font-variant-numeric: tabular-nums; opacity: .82; }
    .abstract-control-panel input[type="range"] { width: 100%; accent-color: #fff; }
    .abstract-control-panel button { border: 1px solid rgba(255,255,255,.22); border-radius: 6px; background: transparent; color: #fff; padding: 7px 8px; font: inherit; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  </style>
</head>
<body>
  <iframe id="preview" src="about:blank"></iframe>
  <select id="source-select" hidden>${options}</select>
  <button class="nav-zone left" id="prev-source" aria-label="previous form"></button>
  <button class="nav-zone right" id="next-source" aria-label="next form"></button>
  <script type="module" src="./art.js"></script>
  <script>
    const iframe = document.getElementById('preview');
    const select = document.getElementById('source-select');
    const prevSource = document.getElementById('prev-source');
    const nextSource = document.getElementById('next-source');
    window.__syntheticVelocityControlsMode = 0;
    document.body.tabIndex = -1;
    document.body.focus();
    const applyControlMode = () => {
      const panel = document.querySelector('.abstract-control-panel');
      if (!panel) return;
      const mode = window.__syntheticVelocityControlsMode || 0;
      panel.dataset.forceHidden = mode === 0 ? 'true' : 'false';
      panel.dataset.controlMode = mode === 2 ? 'all' : 'normal';
      panel.style.display = mode === 0 ? 'none' : 'block';
      panel.open = true;
    };
    const toggleControls = () => {
      window.__syntheticVelocityControlsMode = ((window.__syntheticVelocityControlsMode || 0) + 1) % 3;
      applyControlMode();
    };
    const showAt = (index) => {
      const count = select.options.length;
      if (!count) return;
      select.selectedIndex = (index + count) % count;
      iframe.src = select.value;
    };
    select.addEventListener('change', () => { iframe.src = select.value; });
    const flowchartIndex = Array.from(select.options).findIndex((option) => option.value.endsWith('/example-flowchart.html'));
    showAt(flowchartIndex >= 0 ? flowchartIndex : 0);
    let navTapTimer = 0;
    let lastNavTap = { time: 0, x: 0, y: 0 };
    const navPointers = new Map();
    const flickObject = () => window.dispatchEvent(new Event('synthetic-velocity-flick'));
    const handleNavPointerDown = (event) => {
      event.preventDefault();
      navPointers.set(event.pointerId, { x: event.clientX || 0, y: event.clientY || 0 });
    };
    const handleNavPointerUp = (direction, event) => {
      event.preventDefault();
      const start = navPointers.get(event.pointerId);
      navPointers.delete(event.pointerId);
      const x = event.clientX || 0;
      const y = event.clientY || 0;
      if (start && Math.hypot(x - start.x, y - start.y) > 18) return;
      const now = performance.now();
      const isDoubleTap = now - lastNavTap.time < 420 && Math.hypot(x - lastNavTap.x, y - lastNavTap.y) < 64;
      lastNavTap = { time: now, x, y };
      if (isDoubleTap) {
        clearTimeout(navTapTimer);
        navTapTimer = 0;
        flickObject();
        return;
      }
      clearTimeout(navTapTimer);
      navTapTimer = setTimeout(() => showAt(select.selectedIndex + direction), 360);
    };
    for (const [button, direction] of [[prevSource, -1], [nextSource, 1]]) {
      button.addEventListener('pointerdown', handleNavPointerDown, { passive: false });
      button.addEventListener('pointerup', (event) => handleNavPointerUp(direction, event), { passive: false });
      button.addEventListener('pointercancel', (event) => navPointers.delete(event.pointerId));
      button.addEventListener('click', (event) => event.preventDefault());
    }
    const handleHostKeys = (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleControls();
        return;
      }
      if (event.key?.toLowerCase() === 's') {
        event.preventDefault();
        event.stopImmediatePropagation();
        flickObject();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        showAt(select.selectedIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        showAt(select.selectedIndex + 1);
      }
    };
    window.addEventListener('keydown', handleHostKeys, true);
    document.addEventListener('keydown', handleHostKeys, true);
    iframe.addEventListener('load', () => {
      try {
        iframe.contentWindow?.addEventListener('keydown', handleHostKeys, true);
      } catch (_) {
        // Cross-origin sources cannot be key-bound from here.
      }
    });
  </script>
</body>
</html>
`,
  );
}

async function build(noFetch) {
  const tmpDir = `${SITE_DIR}.tmp`;
  if (await exists(tmpDir)) await rm(tmpDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  let docs = [];
  for (const source of SOURCES) {
    const repoDir = await ensureSource(source, noFetch);
    const sourceAssets = join(repoDir, source.assetPath);
    const out = join(tmpDir, "sources", source.id);
    docs = await copyDirFiltered(sourceAssets, out, source.include);
  }

  await copyFile(join(CLIENT_DIR, "art.js"), join(tmpDir, "art.js"));
  if (await exists(SITE_DIR)) await rm(SITE_DIR, { recursive: true });
  await rename(tmpDir, SITE_DIR);
  await writeHostIndex(docs);
  console.log(`generated synthetic velocity host: ${SITE_DIR}`);
  console.log(`source documents: ${docs.length}`);
}

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const [command = "serve", ...args] = process.argv.slice(2);
if (command !== "serve" && command !== "build") {
  throw new Error(`unknown command: ${command}`);
}
await build(args.includes("--no-fetch"));
if (command === "serve") {
  const host = argValue(args, "--host", "127.0.0.1");
  const port = Number(argValue(args, "--port", "8899"));
  await serveDir(SITE_DIR, host, port);
  console.log(`serving synthetic velocity: http://${host}:${port}/index.html`);
}
