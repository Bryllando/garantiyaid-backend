const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/;

export function protectCsvValue(value) {
  if (value == null) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

export function escapeCsvValue(value) {
  const protectedValue = protectCsvValue(value);
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

export function createCsv(headers, rows) {
  const headerLine = headers.map(({ label }) => escapeCsvValue(label)).join(",");
  const dataLines = rows.map((row) => headers
    .map(({ key }) => escapeCsvValue(row[key]))
    .join(","));
  return `${[headerLine, ...dataLines].join("\r\n")}\r\n`;
}

export function safeDistributionExportFilename(distribution) {
  const date = distribution.distributionDate instanceof Date
    ? distribution.distributionDate.toISOString().slice(0, 10)
    : String(distribution.distributionDate).slice(0, 10);
  const identifier = String(distribution.distributionId)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 36);
  return `garantiyaid-distribution-${date}-${identifier}.csv`;
}
