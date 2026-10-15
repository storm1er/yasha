import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


/** One temp dir for every throwaway test DB; removed on teardown. Workers pick
 *  it up via YASHA_TEST_DB_DIR (env is inherited when workers are spawned). */
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "yasha-test-"));
  process.env.YASHA_TEST_DB_DIR = dir;
  return () => {
    rmSync(dir, { recursive: true, force: true });
  };
}

export { mkdirSync };
