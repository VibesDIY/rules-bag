import { execFileSync } from "node:child_process";
import { reviewFiles } from "./engine.js";
const [repo, range] = process.argv.slice(2);
const names = execFileSync("git", ["-C", repo, "diff", "--name-status", range], { encoding: "utf8" }).trim().split("\n");
const files = names.filter(Boolean).map((l) => { const [st, fn] = l.split("\t"); return { filename: fn, status: st === "A" ? "added" : "modified", patch: execFileSync("git", ["-C", repo, "diff", "-U0", range, "--", fn], { encoding: "utf8", maxBuffer: 1e8 }).split("\n").filter((x) => !/^(diff|index|---|\+\+\+|new file|deleted)/.test(x)).join("\n") }; });
const r = reviewFiles(files, { segments: { result: "block", cement: "block", types: "block", modules: "block", falsy: "block", testing: "block", style: "block", fetch: "block" } });
const by = {}; for (const f of r.findings) by[f.rule] = (by[f.rule] ?? 0) + 1;
console.log(files.length, "files", by, "exceptions", r.exceptions.length);
for (const f of r.findings.slice(0, Number(process.argv[4] ?? 0))) console.log(f.rule, f.path + ":" + f.line);
