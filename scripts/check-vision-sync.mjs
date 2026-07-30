#!/usr/bin/env node

/**
 * Compare docs/vision.md with Org Studio's live vision document.
 *
 * The repository copy carries a short HTML provenance comment. Comparison
 * begins at the first "# Org Studio" heading so that comment does not create
 * false drift.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const LIVE_URL =
  process.env.ORG_STUDIO_VISION_URL ||
  'https://app.orgstudio.dev/api/vision/proj-org-studio/doc';

function normalize(value) {
  const heading = value.indexOf('# Org Studio');
  const body = heading >= 0 ? value.slice(heading) : value;
  return body.replace(/\r\n/g, '\n').trimEnd();
}

async function main() {
  const local = normalize(
    await readFile(new URL('../docs/vision.md', import.meta.url), 'utf8'),
  );
  const response = await fetch(LIVE_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`vision endpoint returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (typeof payload?.content !== 'string') {
    throw new Error('vision endpoint response did not contain string content');
  }

  if (local !== normalize(payload.content)) {
    console.error(
      'docs/vision.md differs from the live Org Studio vision. ' +
      'Review the live change and synchronize the repository copy.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('docs/vision.md matches the live Org Studio vision.');
}

main().catch((error) => {
  console.error(`Vision sync check failed: ${error.message}`);
  process.exitCode = 1;
});
