/**
 * Throughput bench for the Node path — the CLI-side twin of `benchPage` in
 * plugin/probe.ts.
 *
 * Both report the same fields, measured the same way, so a Node (onnxruntime-node)
 * run and an in-Obsidian (WebGPU) run can be compared directly instead of by
 * eyeballing total conversion times. Generation is capped by **tokens**, not
 * wall-clock, so a slow backend yields a smaller tokens/sec rather than a
 * truncated page — and short runs keep the machine away from thermal throttling.
 *
 *   npx tsx tools/bench.ts ../fixtures/attention.pdf --pages 1,2 --max-new-tokens 128
 *   npx tsx tools/bench.ts ../fixtures/attention.pdf --device cpu --dtype q4
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { loadPdf } from "../src/pdf.js";
import { loadVlm } from "../src/vlm.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    pages: { type: "string" },
    "max-new-tokens": { type: "string" },
    device: { type: "string" },
    dtype: { type: "string" },
  },
});

const pdfPath = positionals[0];
if (!pdfPath) {
  process.stderr.write("usage: bench.ts <pdf> [--pages 1,2] [--max-new-tokens N] [--device cpu|webgpu] [--dtype D]\n");
  process.exit(2);
}

const pageList = (values.pages ?? "1").split(",").map((s) => parseInt(s.trim(), 10));
const maxNewTokens = parseInt(values["max-new-tokens"] ?? "128", 10);
const device = (values.device ?? "cpu") as "cpu" | "webgpu" | "auto";

const t0 = Date.now();
const pages = await loadPdf(new Uint8Array(await readFile(pdfPath)));
const tPdf = Date.now();

const vlm = await loadVlm({
  device,
  ...(values.dtype ? { dtype: values.dtype } : {}),
  maxNewTokens,
  // Bounded by tokens; keep the wall-clock backstop from ending runs early.
  perPageTimeoutMs: 3_600_000,
});
const tModel = Date.now();

const results = [];
try {
  for (const page of pageList) {
    const tR0 = Date.now();
    const rendered = await pages.renderPage(page);
    const tR1 = Date.now();

    const { docTags, truncated, genTokens, promptTokens } = await vlm.pageToDocTags(
      rendered.rgba,
      rendered.width,
      rendered.height,
    );
    const genSec = (Date.now() - tR1) / 1000;

    results.push({
      page,
      device,
      dtype: vlm.modelLabel,
      executionProviders: vlm.executionProviders,
      maxNewTokens,
      renderSec: +((tR1 - tR0) / 1000).toFixed(2),
      genSec: +genSec.toFixed(2),
      genTokens,
      promptTokens,
      renderedPx: `${rendered.width}x${rendered.height}`,
      tokensPerSec: +(genTokens / genSec).toFixed(2),
      truncated,
      docTagsChars: docTags.length,
      head: docTags.slice(0, 120),
    });
    process.stderr.write(
      `  page ${page}: ${genTokens} tok in ${genSec.toFixed(1)}s = ${(genTokens / genSec).toFixed(2)} tok/s` +
        ` (${truncated ?? "EOS"})\n`,
    );
  }
} finally {
  vlm.dispose();
  await pages.destroy();
}

process.stdout.write(
  JSON.stringify(
    {
      pdfLoadSec: +((tPdf - t0) / 1000).toFixed(2),
      modelLoadSec: +((tModel - tPdf) / 1000).toFixed(2),
      results,
    },
    null,
    2,
  ) + "\n",
);
