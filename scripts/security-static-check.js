import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skippedDirectories = new Set([
  ".agents",
  ".claude",
  ".git",
  ".windsurf",
  "node_modules",
  "uploads",
  "generated",
]);
const scannedExtensions = new Set([
  ".example",
  ".js",
  ".json",
  ".md",
  ".sql",
  ".ts",
  ".yml",
  ".yaml",
]);
const prohibitedPatterns = [
  { name: "JWT-shaped secret", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "unsafe Prisma raw query", pattern: /\$(?:queryRawUnsafe|executeRawUnsafe)\s*\(/ },
  { name: "dynamic code execution", pattern: /\b(?:eval|Function)\s*\(/ },
  { name: "operating-system command execution", pattern: /node:(?:child_process|cluster)/ },
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(entryPath));
    } else if (scannedExtensions.has(path.extname(entry.name)) || entry.name === ".env.example") {
      files.push(entryPath);
    }
  }

  return files;
}

const findings = [];
for (const file of await filesUnder(root)) {
  const relativePath = path.relative(root, file);
  const content = await readFile(file, "utf8");

  for (const rule of prohibitedPatterns) {
    if (rule.pattern.test(content)) {
      findings.push(`${relativePath}: ${rule.name}`);
    }
  }

  if (relativePath === ".env.example") {
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !/^[A-Z][A-Z0-9_]*=/.test(trimmed)) {
        findings.push(`${relativePath}:${index + 1}: unsafe non-variable content`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Security static check failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  console.log("Security static check passed.");
}
