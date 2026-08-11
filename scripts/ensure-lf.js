"use strict";
const fs = require("fs");
const path = require("path");

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|json|md)$/.test(name) || name === "LICENSE" || name === ".gitattributes") out.push(p);
  }
  return out;
}

const root = path.join(__dirname, "..");
for (const file of walk(root)) {
  const buf = fs.readFileSync(file);
  if (!buf.includes(0x0d)) continue;
  const text = buf.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  fs.writeFileSync(file, text, "utf8");
  console.log("lf:", path.relative(root, file));
}
