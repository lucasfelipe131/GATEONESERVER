import { assertQa06 } from './qa06-bootstrap.js';
import { mkdir, copyFile } from 'node:fs/promises';
assertQa06(process.env);
// Publish the viewport/response-fixture harness only in this guarded QA runtime.
await mkdir(new URL('../public/qa06/', import.meta.url), { recursive: true });
for (const name of ['index.html', 'viewport.css', 'viewport.js'])
  await copyFile(new URL(`qa06-ui/${name}`, import.meta.url), new URL(`../public/qa06/${name}`, import.meta.url));
await copyFile(new URL('qa06-ui/qa06-sw.js', import.meta.url), new URL('../public/qa06-sw.js', import.meta.url));
// Run the existing application, including its real authentication and RBAC.
await import('../src/server.js');
