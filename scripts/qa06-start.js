import { assertQa06 } from './qa06-bootstrap.js';
assertQa06(process.env);
// Run the existing application, including its real authentication and RBAC.
await import('../src/server.js');
