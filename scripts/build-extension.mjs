import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildExtension(out = path.join(root, "dist/extension")) {
await mkdir(out, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["worker", "content", "popup", "options", "clipboard"].map((name) => `extension/${name}.ts`),
  outdir: out, bundle: true, format: "iife", platform: "browser", target: "chrome116", legalComments: "none",
});
for (const file of ["manifest.json", "popup.html", "options.html", "clipboard.html", "style.css"]) {
  await copyFile(path.join(root, "extension", file), path.join(out, file));
}
return out;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(`Chrome extension ready: ${await buildExtension()}`);
}
