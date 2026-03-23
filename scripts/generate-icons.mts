import { copyFile, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSvg = path.join(root, "assets", "app-icon.svg");
const publicDir = path.join(root, "public");
const buildDir = path.join(root, "build");
const publicSvg = path.join(publicDir, "app-icon.svg");
const publicPng = path.join(publicDir, "app-icon.png");
const buildPng = path.join(buildDir, "icon.png");
const buildIcns = path.join(buildDir, "icon.icns");
const masterPng = path.join(buildDir, "icon-1024.png");
const iconsetDir = path.join(buildDir, "app.iconset");

const iconsetVariants = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
] as const;

async function main() {
  await mkdir(publicDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });
  await copyFile(sourceSvg, publicSvg);

  await renderPng(sourceSvg, masterPng);
  await copyFile(masterPng, buildPng);
  await copyFile(masterPng, publicPng);

  if (process.platform === "darwin") {
    await mkdir(iconsetDir, { recursive: true });

    for (const [fileName, size] of iconsetVariants) {
      await run("sips", ["-z", String(size), String(size), masterPng, "--out", path.join(iconsetDir, fileName)]);
    }

    await run("iconutil", ["-c", "icns", iconsetDir, "-o", buildIcns]);
    await rm(iconsetDir, { recursive: true, force: true });
  }

  await rm(masterPng, { force: true });

  console.log(`Generated app icons in ${buildDir}`);
}

async function renderPng(inputPath: string, outputPath: string) {
  try {
    await run("sips", ["-s", "format", "png", inputPath, "--out", outputPath]);
  } catch {
    await run("qlmanage", ["-t", "-s", "1024", "-o", path.dirname(outputPath), inputPath]);
    await copyFile(path.join(path.dirname(outputPath), `${path.basename(inputPath)}.png`), outputPath);
    await rm(path.join(path.dirname(outputPath), `${path.basename(inputPath)}.png`), { force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
