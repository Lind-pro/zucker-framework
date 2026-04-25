import type { ColumnMapping } from './column-mapping';
import type { ImportRow } from './import.service';

type Readable = import('stream').Readable;

/**
 * Import result for a single row — mirrors jetlinks ImportHelper.Importing.
 */
export interface ImportingResult<T> {
  /** 0-based row index */
  row: number;
  /** Raw source data from the file */
  source: Record<string, unknown>;
  /** Converted target entity */
  target: T;
  /** Whether the row was successfully processed */
  success: boolean;
  /** Whether this row failed as part of a batch failure */
  batchError: boolean;
  /** Error message if failed */
  errorMessage?: string;
}

/**
 * Import progress callback.
 */
export interface ImportProgress {
  /** Total rows read so far */
  totalRead: number;
  /** Successfully processed rows */
  successCount: number;
  /** Failed rows */
  errorCount: number;
  /** Current batch number */
  batchNumber: number;
  /** Whether import is complete */
  done: boolean;
}

/**
 * ImportHelper options.
 */
export interface ImportHelperOptions<T> {
  /** Column mappings for parsing */
  mapping: ColumnMapping[];
  /**
   * Batch handler — processes a batch of parsed entities.
   * Should support transactions and idempotency.
   */
  handler: (batch: T[]) => Promise<void>;
  /** Batch buffer size (default: 200, matching jetlinks) */
  bufferSize?: number;
  /**
   * When batch processing fails, fall back to single-row processing.
   * Mirrors jetlinks ImportHelper.fallbackSingle.
   */
  fallbackSingle?: boolean;
  /**
   * Row validation function. Called after parsing, before handler.
   * Should throw an error for invalid rows.
   * Mirrors jetlinks afterRead validation pattern.
   */
  validator?: (item: T, row: number) => void;
  /** Progress callback */
  onProgress?: (progress: ImportProgress) => void;
}

/**
 * ImportHelper — mirrors jetlinks ImportHelper.
 *
 * Provides batch import processing with:
 * - Configurable batch buffer size
 * - Fallback-to-single-row on batch failure (error isolation)
 * - Per-row validation
 * - Progress tracking
 * - Import result collection with success/error per row
 */
export class ImportHelper<T = Record<string, unknown>> {
  private readonly options: Required<
    Pick<ImportHelperOptions<T>, 'bufferSize' | 'fallbackSingle'>
  > &
    ImportHelperOptions<T>;

  constructor(options: ImportHelperOptions<T>) {
    this.options = {
      bufferSize: 200,
      fallbackSingle: false,
      ...options,
    };
  }

  /**
   * Process an import stream.
   *
   * Reads rows from the async generator, batches them, processes each batch
   * through the handler, and collects per-row results.
   *
   * Mirrors jetlinks ImportHelper.doImport() flow:
   * 1. Read rows and parse into entities
   * 2. Validate each row
   * 3. Buffer into batches
   * 4. Execute batch handler
   * 5. On batch failure with fallbackSingle, retry each row individually
   */
  async process(
    rows: AsyncIterable<ImportRow<T>>,
  ): Promise<ImportingResult<T>[]> {
    const allResults: ImportingResult<T>[] = [];
    let batch: ImportingResult<T>[] = [];
    let batchNumber = 0;
    let successCount = 0;
    let errorCount = 0;
    let totalRead = 0;

    for await (const row of rows) {
      totalRead++;
      const importing: ImportingResult<T> = {
        row: row.rowNumber,
        source: row.data as Record<string, unknown>,
        target: row.data,
        success: row.errors.length === 0,
        batchError: false,
        errorMessage: row.errors.length > 0 ? row.errors.join('; ') : undefined,
      };

      // Run validator if row parsed successfully
      if (importing.success && this.options.validator) {
        try {
          this.options.validator(row.data, row.rowNumber);
        } catch (err) {
          importing.success = false;
          importing.errorMessage = err instanceof Error ? err.message : String(err);
        }
      }

      batch.push(importing);

      // Flush batch when buffer is full
      if (batch.length >= this.options.bufferSize) {
        batchNumber++;
        await this.executeBatch(batch);

        for (const r of batch) {
          if (r.success) successCount++;
          else errorCount++;
        }

        allResults.push(...batch);
        this.reportProgress({ totalRead, successCount, errorCount, batchNumber, done: false });
        batch = [];
      }
    }

    // Flush remaining batch
    if (batch.length > 0) {
      batchNumber++;
      await this.executeBatch(batch);

      for (const r of batch) {
        if (r.success) successCount++;
        else errorCount++;
      }

      allResults.push(...batch);
    }

    this.reportProgress({ totalRead, successCount, errorCount, batchNumber, done: true });
    return allResults;
  }

  /**
   * Execute a batch through the handler.
   * On failure with fallbackSingle, retries each row individually.
   * Mirrors jetlinks ImportHelper.executeImport().
   */
  private async executeBatch(batch: ImportingResult<T>[]): Promise<void> {
    const validItems = batch.filter((r) => r.success);
    if (validItems.length === 0) return;

    try {
      await this.options.handler(validItems.map((r) => r.target));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Fallback to single-row processing
      if (this.options.fallbackSingle && validItems.length > 1) {
        for (const item of validItems) {
          try {
            await this.options.handler([item.target]);
          } catch (singleErr) {
            item.success = false;
            item.errorMessage = singleErr instanceof Error
              ? singleErr.message
              : String(singleErr);
          }
        }
      } else {
        // Mark all items in batch as failed
        for (const item of validItems) {
          item.success = false;
          item.batchError = true;
          item.errorMessage = errorMsg;
        }
      }
    }
  }

  private reportProgress(progress: ImportProgress): void {
    this.options.onProgress?.(progress);
  }
}
