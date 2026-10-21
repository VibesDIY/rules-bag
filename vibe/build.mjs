import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
const head = "// Rules Bag Reviewer — backend.js (built from engine.js + handlers.js; one file because backend.js cannot import siblings)\n\n";
writeFileSync("dist/backend.js", head + readFileSync("engine.js", "utf8") + "\n" + readFileSync("handlers.js", "utf8"));
for (const f of ["App.jsx", "access.js"]) copyFileSync(f, "dist/" + f);
console.log("built dist/");
