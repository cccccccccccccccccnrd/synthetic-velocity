#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { serveDir } from "./serve.js";

const env = process.env;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_DIR = join(ROOT, "site");
const OUT_DIR = join(ROOT, "out", "screenshots");
const CHROME = env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(env.EXPORT_PORT ?? "8897");
const SIZE = 2000;
const ONLY = env.EXPORT_ONLY ?? "";
const STILL = (env.EXPORT_STILL ?? "1") !== "0";
const FRAMES = Number(env.EXPORT_FRAMES ?? "1");
const FRAME_DELAY_MS = Number(env.EXPORT_FRAME_DELAY_MS ?? "500");
const WARMUP_MS = Number(env.EXPORT_WARMUP_MS ?? "120");
const EVOLVE_VELOCITY = (env.EXPORT_EVOLVE_VELOCITY ?? "1") !== "0";

function slugFromPath(value) {
  const file = value.split("/").pop() ?? "form";
  return file.replace(/\.html?$/i, "").replace(/[^a-z0-9_-]+/gi, "-");
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const server = await serveDir(SITE_DIR, "127.0.0.1", PORT);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      `--window-size=${SIZE},${SIZE}`,
      "--hide-scrollbars",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-web-security",
    ],
    defaultViewport: { width: SIZE, height: SIZE, deviceScaleFactor: 1 },
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(45_000);
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, {
      waitUntil: "networkidle2",
    });
    await page.waitForSelector("canvas.abstract-shader-canvas", {
      visible: true,
    });

    const options = await page.$$eval(
      "#source-select option",
      (nodes) =>
        nodes.map((node) => ({
          value: node.value,
          label: node.textContent ?? "",
        })),
    );

    const selectedOptions = ONLY
      ? options.filter((option) => option.value.includes(ONLY))
      : options;

    if (STILL) {
      await page.evaluate(() => {
        const anyWindow = window;
        if (!anyWindow.params) return;
        // Still export: disable real pipe/camera motion, keep synthetic trails on.
        anyWindow.params.trailMotion = 0;
        anyWindow.params.syntheticTrail = 1;
        anyWindow.params.trailEnabled = 1;
        anyWindow.trails?.reset?.();
      });
    }

    console.log(
      `exporting ${selectedOptions.length} forms at ${SIZE}x${SIZE}px to ${OUT_DIR}`,
    );

    for (let i = 0; i < selectedOptions.length; i++) {
      const option = selectedOptions[i];
      const name = `${String(i + 1).padStart(3, "0")}-${
        slugFromPath(option.value)
      }.png`;
      const output = join(OUT_DIR, name);

      const sourceIndex = options.findIndex((candidate) =>
        candidate.value === option.value
      );
      await page.evaluate((index) => {
        const select = document.getElementById("source-select");
        const iframe = document.getElementById("preview");
        if (!select || !iframe) throw new Error("missing source controls");
        select.selectedIndex = index;
        iframe.src = select.value;
      }, sourceIndex);

      await page.waitForFunction(
        (index) => {
          const select = document.getElementById("source-select");
          const iframe = document.getElementById("preview");
          return Boolean(
            select && iframe && select.selectedIndex === index &&
              iframe.contentDocument?.querySelector("svg"),
          );
        },
        {},
        sourceIndex,
      );

      // Give SVG extraction/geometry rebuild time, then reset the history so the
      // frame series captures the trail building up instead of an already
      // converged steady state.
      await new Promise((resolve) => setTimeout(resolve, WARMUP_MS));
      if (STILL) {
        await page.evaluate(() => {
          const anyWindow = window;
          if (!anyWindow.params) return;
          anyWindow.params.trailMotion = 0;
          anyWindow.params.syntheticTrail = 1;
          anyWindow.params.trailEnabled = 1;
          anyWindow.params.trailLength = 3.0;
          anyWindow.params.trailOpacity = 1.12;
          anyWindow.params.velocityScale = 0.9;
          anyWindow.params.brightnessPersistence = 1.18;
          anyWindow.params.historyDecay = 0.55;
          anyWindow.trails?.reset?.();
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const baseVelocity = await page.evaluate(() => {
        const anyWindow = window;
        return {
          x: anyWindow.params?.syntheticVelocityX ?? -0.064,
          y: anyWindow.params?.syntheticVelocityY ?? 0.024,
        };
      });

      for (let frame = 0; frame < FRAMES; frame++) {
        if (EVOLVE_VELOCITY && FRAMES > 1) {
          const t = frame / Math.max(FRAMES - 1, 1);
          const factor = 0.45 + t * 1.25;
          const angle = (t - 0.5) * 0.45;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const x = (baseVelocity.x * cos - baseVelocity.y * sin) * factor;
          const y = (baseVelocity.x * sin + baseVelocity.y * cos) * factor;
          await page.evaluate((velocity) => {
            const anyWindow = window;
            if (!anyWindow.params) return;
            anyWindow.params.syntheticVelocityX = velocity.x;
            anyWindow.params.syntheticVelocityY = velocity.y;
            anyWindow.trails?.setOptions?.(anyWindow.params);
          }, { x, y });
        }

        await new Promise((resolve) =>
          setTimeout(resolve, frame === 0 ? 120 : FRAME_DELAY_MS)
        );
        const frameOutput = FRAMES > 1
          ? output.replace(
            /\.png$/i,
            `-frame-${String(frame + 1).padStart(2, "0")}.png`,
          )
          : output;
        await page.screenshot({
          path: frameOutput,
          type: "png",
          clip: { x: 0, y: 0, width: SIZE, height: SIZE },
        });
        console.log(
          `${i + 1}/${selectedOptions.length} ${name} frame ${
            frame + 1
          }/${FRAMES}`,
        );
      }
    }
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
}

await main();
