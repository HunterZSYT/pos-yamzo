import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const websiteMenuPath = path.resolve(
  process.argv[2] ?? "E:/Yamzo/Website/src/data/menu.ts"
);
const outputPath = path.resolve(
  process.argv[3] ?? "resources/website-menu-contract.json"
);

if (!fs.existsSync(websiteMenuPath)) {
  throw new Error(`Canonical website menu not found: ${websiteMenuPath}`);
}

const source = fs.readFileSync(websiteMenuPath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  },
  fileName: websiteMenuPath,
  reportDiagnostics: true
});
const errors = (transpiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
);
if (errors.length > 0) {
  throw new Error("Canonical website menu TypeScript could not be parsed.");
}

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
const menuModule = await import(moduleUrl);
const entries = menuModule.menuItems.flatMap((item) => {
  const websiteName = item.name.en;
  if (item.pricing.kind === "fixed") {
    return [{
      websitePublicId: item.id,
      effectiveUnitPrice: item.pricing.price,
      websiteName,
      expectedPosName: websiteName
    }];
  }
  return item.pricing.variants.map((variant) => ({
    websitePublicId: item.id,
    effectiveUnitPrice: variant.price,
    websiteName,
    expectedPosName: item.id === "menu_item_shingara_combo"
      ? websiteName
      : `${websiteName} ${capitalize(String(variant.id).split("-")[0])} Pack`
  }));
});

const canonicalEntries = JSON.stringify(entries);
const contract = {
  schemaVersion: 1,
  catalogDigest: createHash("sha256").update(canonicalEntries).digest("hex"),
  entries
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, entries: entries.length, catalogDigest: contract.catalogDigest }));

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
