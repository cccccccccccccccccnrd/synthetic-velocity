/**
 * Pre-render the 2D shape of every source diagram into site/shapes/<name>.svg
 * for the "d" overview grid. The shapes come from art.js itself
 * (window.__syntheticVelocityShapeFor), so they match what the pipes are built
 * from. Needs a local Chrome (CHROME env var, macOS default otherwise).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { serveDir } from "./serve.js";

const CHROME = process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// White outlines on black, constant on-screen line width at any tile size.
const SHAPE_STYLE =
  "<style>* { fill: none !important; stroke: #fff !important; stroke-width: 1.5px !important; vector-effect: non-scaling-stroke; }</style>";

export async function writeShapes(siteDir, documents) {
  const outDir = join(siteDir, "shapes");
  await mkdir(outDir, { recursive: true });

  const server = await serveDir(siteDir, "127.0.0.1", 0);
  const { port } = server.address();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      defaultViewport: { width: 1200, height: 800 },
    });
  } catch (error) {
    server.close();
    console.warn(
      `shapes: skipped, could not start Chrome (${error.message}). Set CHROME=/path/to/chrome.`,
    );
    return 0;
  }

  let written = 0;
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`http://127.0.0.1:${port}/index.html`, {
      waitUntil: "load",
    });
    await page.waitForFunction(() =>
      typeof window.__syntheticVelocityShapeFor === "function"
    );

    for (const doc of documents) {
      const shape = await page.evaluate(async (src) => {
        // Rendered (not display:none) so computed styles and getBBox work.
        const frame = document.createElement("iframe");
        frame.style.cssText =
          "position:fixed;inset:0;width:100vw;height:100vh;border:0;opacity:0;pointer-events:none";
        await new Promise((resolve) => {
          frame.addEventListener("load", resolve, { once: true });
          frame.src = src;
          document.body.appendChild(frame);
        });
        try {
          const svg = frame.contentDocument?.querySelector("svg");
          return svg ? window.__syntheticVelocityShapeFor(svg) : null;
        } finally {
          frame.remove();
        }
      }, `sources/diagram-design/${doc}`);

      if (!shape) {
        console.warn(`shapes: no svg in ${doc}`);
        continue;
      }
      const styled = shape.replace(/<svg\b[^>]*>/, (tag) => tag + SHAPE_STYLE);
      await writeFile(
        join(outDir, doc.replace(/\.html?$/i, ".svg")),
        styled,
      );
      written++;
    }
  } finally {
    await browser.close();
    server.close();
  }
  return written;
}
