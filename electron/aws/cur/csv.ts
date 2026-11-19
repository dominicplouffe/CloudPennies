// A small streaming RFC 4180 parser: quoted fields, embedded commas / newlines / doubled quotes, CRLF or LF.
// Input arrives in arbitrary chunks; rows are handed out as soon as they are complete.

export class CsvParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  /** a quote was seen inside a quoted field; the next character decides whether it closes the field or is an escaped quote */
  private quotePending = false;
  /** the current field started with a quote (so an empty value is still a field, and the row is not blank) */
  private quoted = false;
  private skipLf = false;
  private first = true;

  constructor(private readonly onRow: (cells: string[]) => void) {}

  write(chunk: string): void {
    let s = chunk;
    if (this.first && s.length) {
      this.first = false;
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    }
    const n = s.length;
    let i = 0;
    while (i < n) {
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (s[i] === '"') {
            this.field += '"';
            i++;
            continue;
          }
          this.inQuotes = false; // the pending quote closed the field; re-read this character unquoted
          continue;
        }
        const q = s.indexOf('"', i);
        if (q < 0) {
          this.field += s.slice(i);
          return;
        }
        this.field += s.slice(i, q);
        this.quotePending = true;
        i = q + 1;
        continue;
      }
      const c = s[i];
      if (this.skipLf) {
        this.skipLf = false;
        if (c === '\n') {
          i++;
          continue;
        }
      }
      if (c === ',') {
        this.endField();
        i++;
      } else if (c === '\n') {
        this.endRow();
        i++;
      } else if (c === '\r') {
        this.endRow();
        this.skipLf = true;
        i++;
      } else if (c === '"' && this.field === '' && !this.quoted) {
        this.inQuotes = true;
        this.quoted = true;
        i++;
      } else {
        // take the whole unquoted run at once
        let j = i + 1;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === 44 || d === 10 || d === 13) break;
          j++;
        }
        this.field += s.slice(i, j);
        i = j;
      }
    }
  }

  /** Flush the last row (a file need not end with a newline). */
  end(): void {
    if (this.inQuotes) {
      this.inQuotes = false;
      this.quotePending = false;
    }
    if (this.field !== '' || this.quoted || this.row.length) this.endRow();
  }

  private endField(): void {
    this.row.push(this.field);
    this.field = '';
    this.quoted = false;
  }

  private endRow(): void {
    const blank = this.row.length === 0 && this.field === '' && !this.quoted;
    this.endField();
    const row = this.row;
    this.row = [];
    if (!blank) this.onRow(row);
  }
}

/** Parse a whole string (tests and small inputs). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const p = new CsvParser((r) => rows.push(r));
  p.write(text);
  p.end();
  return rows;
}
