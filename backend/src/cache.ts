// Generic mtime+size-keyed cache for expensive per-file computations (e.g. parsing a transcript).
// A file's cached value is reused as long as its mtime/size haven't changed, so an unchanged file
// costs just a stat() instead of re-reading and reprocessing its full contents.
type CacheEntry<T> = { mtimeMs: number; size: number; value: T };

export class StatCache<T> {
  private entries = new Map<string, CacheEntry<T>>();

  get(path: string, mtimeMs: number, size: number): T | undefined {
    const cached = this.entries.get(path);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.value;
    return undefined;
  }

  set(path: string, mtimeMs: number, size: number, value: T): void {
    this.entries.set(path, { mtimeMs, size, value });
  }
}
