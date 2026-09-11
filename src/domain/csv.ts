export interface CsvParseError {
  message: string;
  /** 1-based source line where the problem starts, when known. */
  line?: number;
}

export interface CsvTable {
  /** Header cells, one per column. */
  headers: string[];
  /** Parsed data rows; all-whitespace physical rows are skipped. */
  rows: CsvRow[];
  /** Number of blank physical rows skipped between records. */
  blankRows: number;
  errors: CsvParseError[];
}

export interface CsvRow {
  /** Physical line in the source where the record begins (1-based). */
  line: number;
  cells: string[];
}

/**
 * Parse CSV text following RFC 4180: quoted fields, doubled quotes as escapes,
 * CR/LF/CRLF newlines (including inside quotes), and a leading BOM.
 */
export function parseCsv(input: string): CsvTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: CsvRow[] = [];
  const errors: CsvParseError[] = [];
  let blankRows = 0;
  let field = '';
  let record: string[] = [];
  let recordStartLine = 1;
  let line = 1;
  let inQuotes = false;
  let sawContent = false;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const closeRecord = () => {
    pushField();
    const isBlank = !sawContent && record.length === 1 && record[0].trim() === '';
    if (isBlank) {
      blankRows += 1;
    } else {
      rows.push({ line: recordStartLine, cells: record });
    }
    record = [];
    sawContent = false;
  };

  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (char === '\n') line += 1;
      if (char === '\r' && text[i + 1] !== '\n') line += 1;
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      // A quote may only open a field at its start; anything else is literal.
      if (field.length === 0) {
        inQuotes = true;
        sawContent = true;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === ',') {
      sawContent = true;
      pushField();
      i += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      line += 1;
      closeRecord();
      recordStartLine = line;
      i += 1;
      continue;
    }
    field += char;
    if (!/\s/.test(char)) sawContent = true;
    i += 1;
  }

  if (inQuotes) {
    errors.push({ message: 'A quoted field is missing its closing double quote.', line: recordStartLine });
    // Recover by treating the unterminated field as the last record.
    pushField();
    rows.push({ line: recordStartLine, cells: record });
  } else if (record.length > 0 || field.length > 0) {
    closeRecord();
  }

  const [header, ...dataRows] = rows;
  return {
    headers: header ? header.cells.map((cell) => cell.trim()) : [],
    rows: dataRows,
    blankRows,
    errors: header ? errors : [{ message: 'The file is empty. Add a header row with the required columns.' }, ...errors],
  };
}
