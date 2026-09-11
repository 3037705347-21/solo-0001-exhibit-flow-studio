import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('splits a simple header and rows', () => {
    const table = parseCsv('Accession ID,Title\nAF-1,Lantern\nAF-2,Press\n');
    expect(table.headers).toEqual(['Accession ID', 'Title']);
    expect(table.rows.map((row) => row.cells)).toEqual([['AF-1', 'Lantern'], ['AF-2', 'Press']]);
  });

  it('handles commas inside double-quoted fields', () => {
    const table = parseCsv('Title,Maker\n"Cooke, H. B. & Co.","Brass, glass"\n');
    expect(table.rows[0].cells).toEqual(['Cooke, H. B. & Co.', 'Brass, glass']);
  });

  it('handles doubled quote escapes', () => {
    const table = parseCsv('Summary\n"A ""great"" lantern"\n');
    expect(table.rows[0].cells[0]).toBe('A "great" lantern');
  });

  it('handles newlines inside quoted fields and tracks source lines', () => {
    const table = parseCsv('ID,Summary\nAF-1,"line one\nline two"\nAF-2,plain\n');
    expect(table.rows[0].cells[1]).toBe('line one\nline two');
    expect(table.rows[0].line).toBe(2);
    expect(table.rows[1]).toMatchObject({ line: 4, cells: ['AF-2', 'plain'] });
  });

  it('accepts CRLF, lone CR, and leading BOM', () => {
    const table = parseCsv(String.fromCharCode(0xfeff) + 'ID,Title\r\nAF-1,One\rAF-2,Two\r\n');
    expect(table.headers).toEqual(['ID', 'Title']);
    expect(table.rows.map((row) => row.cells)).toEqual([['AF-1', 'One'], ['AF-2', 'Two']]);
  });

  it('skips empty physical rows and counts them', () => {
    const table = parseCsv('ID,Title\n\nAF-1,One\n   \n\nAF-2,Two\n');
    expect(table.rows.map((row) => row.cells[1])).toEqual(['One', 'Two']);
    expect(table.blankRows).toBe(3);
  });

  it('keeps a row whose empty value is quoted next to real values', () => {
    const table = parseCsv('ID,Title,Note\nAF-1,,""\n');
    expect(table.rows[0].cells).toEqual(['AF-1', '', '']);
  });

  it('flags an unterminated quoted field', () => {
    const table = parseCsv('ID,Title\nAF-1,"open quote\nAF-2,plain\n');
    expect(table.errors[0]?.message).toMatch(/closing double quote/);
    // The recovery record preserves what was read.
    expect(table.rows.length).toBeGreaterThan(0);
  });

  it('reports a file error for empty input', () => {
    const table = parseCsv('');
    expect(table.headers).toEqual([]);
    expect(table.errors[0]?.message).toMatch(/empty/i);
  });

  it('handles a header without any data rows', () => {
    const table = parseCsv('ID,Title\n');
    expect(table.headers).toEqual(['ID', 'Title']);
    expect(table.rows).toEqual([]);
    expect(table.errors).toEqual([]);
  });
});
