import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelRoot = path.join(projectRoot, "partof_BP3D_4.0_obj_99", "partof_BP3D_4.0_obj_99");
const fields = [
  ["id", /^#[ \t]*File ID[ \t]*:[ \t]*([^\r\n]*)/m],
  ["representation", /^#[ \t]*Representation ID[ \t]*:[ \t]*([^\r\n]*)/m],
  ["concept", /^#[ \t]*Concept ID[ \t]*:[ \t]*([^\r\n]*)/m],
  ["name", /^#[ \t]*English name[ \t]*:[ \t]*([^\r\n]*)/m],
  ["bounds", /^#[ \t]*Bounds\(mm\)[ \t]*:[ \t]*([^\r\n]*)/m],
  ["volume", /^#[ \t]*Volume\(cm3\)[ \t]*:[ \t]*([^\r\n]*)/m],
];

const files = (await readdir(modelRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".obj"))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

const catalog = [];
for (const file of files) {
  const content = (await readFile(path.join(modelRoot, file), "utf8")).slice(0, 8192);
  const item = { file };
  for (const [key, pattern] of fields) item[key] = content.match(pattern)?.[1]?.trim() || "";
  if (!item.id) item.id = path.basename(file, ".obj");
  if (!item.name) item.name = item.id;
  catalog.push(item);
}

await writeFile(path.join(projectRoot, "model-catalog.json"), `${JSON.stringify(catalog)}\n`, "utf8");
console.log(`Wrote ${catalog.length} OBJ entries to model-catalog.json`);
