// Builds the VS Code extension and packs it as a .vsix (a zip with a manifest) without extra tools:
// `node scripts/package-vscode.ts` → dist/agent-desk-vscode-<version>.vsix
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { fields, nonEmpty } from "../src/core/check.ts";

const root = path.join(import.meta.dirname, "..");
const ext = path.join(root, "adapters", "vscode");
const out = path.join(ext, "out");

fs.rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(ext, "tsconfig.json")], { stdio: "inherit" });

const manifest = fields(JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8")), "adapters/vscode/package.json");
const name = nonEmpty(manifest.name, "name");
const publisher = nonEmpty(manifest.publisher, "publisher");
const version = nonEmpty(manifest.version, "version");
const engine = nonEmpty(fields(manifest.engines, "engines").vscode, "engines.vscode");
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const files = new Map<string, Buffer>();
files.set(
  "[Content_Types].xml",
  Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/>' +
      '<Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>\n',
  ),
);
files.set(
  "extension.vsixmanifest",
  Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(name)}" Version="${xml(version)}" Publisher="${xml(publisher)}"/>
    <DisplayName>${xml(String(manifest.displayName ?? name))}</DisplayName>
    <Description xml:space="preserve">${xml(String(manifest.description ?? ""))}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(engine)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
`),
);
files.set("extension/package.json", fs.readFileSync(path.join(ext, "package.json")));
for (const file of fs.readdirSync(out, { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue;
  const full = path.join(file.parentPath, file.name);
  files.set(`extension/out/${path.relative(out, full).split(path.sep).join("/")}`, fs.readFileSync(full));
}

const target = path.join(root, "dist", `agent-desk-vscode-${version}.vsix`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, zip(files));
process.stdout.write(`${target} (${files.size} files)\n`);

/** A plain zip archive (deflate, no encryption, no zip64): enough for a few small files. */
function zip(entries: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    locals.push(head, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
