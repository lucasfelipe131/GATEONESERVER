import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('admin API client does not declare JSON for an empty request', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(source, /if \(options\.body !== undefined && options\.body !== null/);
  assert.doesNotMatch(
    source,
    /headers:\s*\{\s*['"]Content-Type['"]:\s*['"]application\/json['"]/
  );
});
