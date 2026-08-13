#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-run=git

/**
 * synthetic velocity pipeline.
 *
 * This repo owns the artwork. External repositories are source material:
 * source repo HTML/SVG → extracted 2D forms → hosted iframe → 3D pipes → shader.
 */

import { serveDir } from "jsr:@std/http/file-server";
import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const INPUT_DIR = join(ROOT, "in");
const SITE_DIR = join(ROOT, "site");
const CLIENT_DIR = join(ROOT, "src", "client");

interface SourceSpec {
  id: string;
  repoUrl: string;
  branch: string;
  assetPath: string;
  include: RegExp;
}

const SOURCES: SourceSpec[] = [
  {
    id: "diagram-design",
    repoUrl: "https://github.com/cathrynlavery/diagram-design.git",
    branch: "main",
    assetPath: "skills/diagram-design/assets",
    include: /^example.*\.html$|^index\.html$/,
  },
];

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function run(command: string[], cwd = ROOT): Promise<void> {
  console.log("$", command.join(" "));
  const child = new Deno.Command(command[0], {
    args: command.slice(1),
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.output();
  if (!status.success) throw new Error(`command failed: ${command.join(" ")}`);
}

async function ensureSource(
  source: SourceSpec,
  noFetch: boolean,
): Promise<string> {
  const repoDir = join(INPUT_DIR, source.id, "repo");
  if (noFetch && await exists(join(repoDir, source.assetPath))) return repoDir;

  await Deno.mkdir(dirname(repoDir), { recursive: true });
  if (!await exists(join(repoDir, ".git"))) {
    if (await exists(repoDir)) await Deno.remove(repoDir, { recursive: true });
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

async function copyDirFiltered(
  sourceDir: string,
  outDir: string,
  include: RegExp,
): Promise<string[]> {
  await Deno.mkdir(outDir, { recursive: true });
  const copied: string[] = [];
  for await (const entry of Deno.readDir(sourceDir)) {
    if (!entry.isFile || !include.test(entry.name)) continue;
    await Deno.copyFile(join(sourceDir, entry.name), join(outDir, entry.name));
    copied.push(entry.name);
  }
  copied.sort();
  return copied;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  ).replaceAll('"', "&quot;");
}

async function writeHostIndex(documents: string[]): Promise<void> {
  const sourceDocuments = documents.filter((doc) => doc !== "index.html");
  const options = sourceDocuments
    .map((doc) =>
      `<option value="sources/diagram-design/${escapeHtml(doc)}">${
        escapeHtml(doc)
      }</option>`
    )
    .join("\n");

  await Deno.writeTextFile(
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
    .mobile-hit-zone { position: fixed; inset: 0; z-index: 80; background: transparent; touch-action: none; }
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
  <div id="mobile-hit-zone" class="mobile-hit-zone" aria-hidden="true"></div>
  <script type="module" src="./art.js"></script>
  <script>
    const iframe = document.getElementById('preview');
    const select = document.getElementById('source-select');
    const mobileHitZone = document.getElementById('mobile-hit-zone');
    window.__syntheticVelocityControlsVisible = false;
    document.body.tabIndex = -1;
    document.body.focus();
    const toggleControls = () => {
      window.__syntheticVelocityControlsVisible = !window.__syntheticVelocityControlsVisible;
      const panel = document.querySelector('.abstract-control-panel');
      if (!panel) return;
      panel.dataset.forceHidden = window.__syntheticVelocityControlsVisible ? 'false' : 'true';
      panel.style.display = window.__syntheticVelocityControlsVisible ? 'block' : 'none';
      panel.open = true;
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
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let controlsTouchTimer = 0;
    mobileHitZone.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      touchStartX = event.clientX;
      touchStartY = event.clientY;
      touchStartTime = performance.now();
      controlsTouchTimer = window.setTimeout(() => toggleControls(), 650);
    }, true);
    mobileHitZone.addEventListener('pointermove', (event) => {
      if (Math.hypot(event.clientX - touchStartX, event.clientY - touchStartY) > 16) window.clearTimeout(controlsTouchTimer);
    }, true);
    mobileHitZone.addEventListener('pointerup', (event) => {
      window.clearTimeout(controlsTouchTimer);
      const dx = event.clientX - touchStartX;
      const dy = event.clientY - touchStartY;
      const dt = performance.now() - touchStartTime;
      if (dt < 700 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        showAt(select.selectedIndex + (dx < 0 ? 1 : -1));
      }
    }, true);
    mobileHitZone.addEventListener('pointercancel', () => window.clearTimeout(controlsTouchTimer), true);
    const handleHostKeys = (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleControls();
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

async function build(noFetch: boolean): Promise<void> {
  const tmpDir = `${SITE_DIR}.tmp`;
  if (await exists(tmpDir)) await Deno.remove(tmpDir, { recursive: true });
  await Deno.mkdir(tmpDir, { recursive: true });

  let docs: string[] = [];
  for (const source of SOURCES) {
    const repoDir = await ensureSource(source, noFetch);
    const sourceAssets = join(repoDir, source.assetPath);
    const out = join(tmpDir, "sources", source.id);
    docs = await copyDirFiltered(sourceAssets, out, source.include);
  }

  await Deno.copyFile(join(CLIENT_DIR, "art.js"), join(tmpDir, "art.js"));
  if (await exists(SITE_DIR)) await Deno.remove(SITE_DIR, { recursive: true });
  await Deno.rename(tmpDir, SITE_DIR);
  await writeHostIndex(docs);
  console.log(`generated synthetic velocity host: ${SITE_DIR}`);
  console.log(`source documents: ${docs.length}`);
}

async function serveSite(host: string, port: number): Promise<void> {
  console.log(`serving synthetic velocity: http://${host}:${port}/index.html`);
  Deno.serve({ hostname: host, port }, (request) =>
    serveDir(request, {
      fsRoot: SITE_DIR,
      urlRoot: "",
      showDirListing: false,
    }));
}

function argValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

if (import.meta.main) {
  const [command = "serve", ...args] = Deno.args;
  const noFetch = args.includes("--no-fetch");
  await build(noFetch);
  if (command === "serve") {
    await serveSite(
      argValue(args, "--host", "127.0.0.1"),
      Number(argValue(args, "--port", "8899")),
    );
  } else if (command !== "build") {
    throw new Error(`unknown command: ${command}`);
  }
}
