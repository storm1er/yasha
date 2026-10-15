// Client-side projections of /api/import/gemini* responses (see batchView +
// buildGeminiImportReport server-side; kept in sync by the routes' contract).

export const TERMINAL: readonly string[] = ["succeeded", "partial", "failed", "cancelled"];

export type ImportBatchView = {
  importId: string;
  status: string;
  filename: string | null;
  bytes: number;
  error: string | null;
  options: { learnFromImports: boolean };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  checkpoint: { offset: number; lines: number };
  counts: {
    lines: number;
    imported: number;
    skippedUnchanged: number;
    skippedChanged: number;
    failed: number;
    malformed: number;
    flagged: number;
  };
};

export type ImportReportView = {
  batchId: string;
  status: string;
  error: string | null;
  failures: { externalId: string; reason: string }[];
  malformedSamples: string[];
  duplicateGroups: { bodyHash: string; count: number; externalIds: string[] }[];
  suspectRun: { startLine: number; length: number } | null;
};
