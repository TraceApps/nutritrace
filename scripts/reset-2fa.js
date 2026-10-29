#!/usr/bin/env node
/**
 * `npm run reset-2fa -- <username>` from a NutriTrace checkout (#222): runs
 * server/scripts/reset-2fa.js from the server folder, as the server runs.
 * In the Docker image the server folder is /app and this file isn't there:
 * /app/scripts/reset-2fa.js is the server's own, so the same command works.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
process.chdir(serverDir);
await import(pathToFileURL(path.join(serverDir, 'scripts', 'reset-2fa.js')).href);
