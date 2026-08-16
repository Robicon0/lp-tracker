function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (s === "") return "";
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadBlob(filename: string, content: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportCSV(filename: string, rows: object[]): void {
  if (typeof window === "undefined") return;

  if (rows.length === 0) {
    downloadBlob(filename, "");
    return;
  }

  const headerSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row as Record<string, unknown>)) {
      headerSet.add(key);
    }
  }
  const headers = Array.from(headerSet);

  const lines: string[] = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    lines.push(headers.map((h) => escapeCell(r[h])).join(","));
  }
  downloadBlob(filename, lines.join("\n"));
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else if (ch === '"' && cur === "") {
      inQuotes = true;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function parseCSV(text: string): Record<string, string>[] {
  try {
    if (!text || typeof text !== "string") return [];
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return [];
    const headers = splitCsvLine(lines[0]).map((h) => h.trim());
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]);
      const row: Record<string, string> = {};
      headers.forEach((h, j) => {
        row[h] = cells[j] ?? "";
      });
      rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}
