// Readers for report data files on local disk. Both hand out normalized line items one at a time and
// never hold more than one Parquet row group / one CSV chunk in memory.
import { createReadStream, promises as fs } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, gunzipSync } from 'node:zlib';
import { asyncBufferFromFile, parquetMetadataAsync, parquetRead, parquetSchema, type Compressors } from 'hyparquet';
import { decompressZstd } from 'hyparquet-compressors';
import type { CostBasis } from '../../../src/core/types';
import { FIELDS, missingRequired, requiredColumnNames, resolveColumns, toLineItem, type Field, type LineItem } from './columns';
import { CsvParser } from './csv';

export type OnLineItem = (item: LineItem) => void;

export interface ReadStats {
  /** rows in the file */
  rows: number;
  /** rows that became line items (not Credit/Refund, with a date) */
  kept: number;
}

/**
 * Snappy is built into hyparquet. gzip goes through zlib; zstd through the pure-JS decoder of
 * hyparquet-compressors (imported by name so that its brotli/lz4 tables are not bundled).
 */
const COMPRESSORS: Compressors = {
  GZIP: (input) => {
    const out = gunzipSync(input);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  },
  ZSTD: (input) => decompressZstd(input),
};

function missingColumnsError(file: string, missing: Field[]): Error {
  return new Error(`A report file does not have the expected columns (${requiredColumnNames(missing)} missing in ${file}).`);
}

/** Read a Parquet file (snappy, gzip or zstd pages) row group by row group, decoding only the needed columns. */
export async function readParquetFile(file: string, basis: CostBasis, onItem: OnLineItem, label = file): Promise<ReadStats> {
  const buffer = await asyncBufferFromFile(file);
  const metadata = await parquetMetadataAsync(buffer);
  const names = parquetSchema(metadata).children.map((c) => c.element.name);
  const map = resolveColumns(names);
  const missing = missingRequired(map);
  if (missing.length) throw missingColumnsError(label, missing);
  const columns = [...new Set(FIELDS.map((f) => map[f]).filter((c): c is string => !!c))];

  const stats: ReadStats = { rows: 0, kept: 0 };
  let row: Record<string, unknown> = {};
  const get = (f: Field): unknown => {
    const c = map[f];
    return c === undefined ? undefined : row[c];
  };
  let rowStart = 0;
  for (const group of metadata.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    if (rowEnd > rowStart) {
      await parquetRead({
        file: buffer,
        metadata,
        columns,
        rowStart,
        rowEnd,
        rowFormat: 'object',
        compressors: COMPRESSORS,
        onComplete: (rows: Record<string, unknown>[]) => {
          for (const r of rows) {
            row = r;
            stats.rows++;
            const item = toLineItem(get, basis);
            if (item) {
              stats.kept++;
              onItem(item);
            }
          }
        },
      });
    }
    rowStart = rowEnd;
  }
  return stats;
}

async function isGzip(file: string): Promise<boolean> {
  const fh = await fs.open(file, 'r');
  try {
    const b = Buffer.alloc(2);
    const { bytesRead } = await fh.read(b, 0, 2, 0);
    return bytesRead === 2 && b[0] === 0x1f && b[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

/** Read a CSV file (gzip-compressed, or plain) as a stream. The first row is the header. */
export async function readCsvFile(file: string, basis: CostBasis, onItem: OnLineItem, label = file): Promise<ReadStats> {
  const stats: ReadStats = { rows: 0, kept: 0 };
  let index: Partial<Record<Field, number>> | null = null;
  let cells: string[] = [];
  const get = (f: Field): unknown => {
    const i = index?.[f];
    return i === undefined ? undefined : cells[i];
  };
  let failure: Error | null = null;
  const parser = new CsvParser((row) => {
    if (failure) return;
    if (!index) {
      const map = resolveColumns(row);
      const missing = missingRequired(map);
      if (missing.length) {
        failure = missingColumnsError(label, missing);
        return;
      }
      index = {};
      for (const f of FIELDS) {
        const name = map[f];
        if (name !== undefined) index[f] = row.indexOf(name);
      }
      return;
    }
    cells = row;
    stats.rows++;
    const item = toLineItem(get, basis);
    if (item) {
      stats.kept++;
      onItem(item);
    }
  });

  const source = createReadStream(file);
  let stream: NodeJS.ReadableStream & { destroy(e?: Error): unknown } = source;
  if (await isGzip(file)) {
    const gunzip = createGunzip();
    source.on('error', (e) => gunzip.destroy(e));
    stream = source.pipe(gunzip);
  }
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of stream) {
      parser.write(decoder.write(chunk as Buffer));
      if (failure) throw failure;
    }
    parser.write(decoder.end());
    parser.end();
    if (failure) throw failure;
  } finally {
    source.destroy();
  }
  return stats;
}

export function readDataFile(kind: 'parquet' | 'csv', file: string, basis: CostBasis, onItem: OnLineItem, label = file): Promise<ReadStats> {
  return kind === 'parquet' ? readParquetFile(file, basis, onItem, label) : readCsvFile(file, basis, onItem, label);
}
