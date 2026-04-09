#!/usr/bin/env node
/**
 * postinstall.cjs — patch third-party Capacitor plugins to work with our build.
 *
 * Some upstream plugins ship with stale versions or config that fails with
 * newer tooling. We patch them in-place after npm install so we don't need
 * to fork the plugins.
 *
 * Each patch is wrapped in try/catch so a missing file doesn't break npm install.
 */
const fs = require('fs');
const path = require('path');

function patch(file, replacements, label) {
  try {
    const fullPath = path.join(process.cwd(), file);
    if (!fs.existsSync(fullPath)) return;
    let s = fs.readFileSync(fullPath, 'utf8');
    let changed = false;
    for (const [from, to] of replacements) {
      if (s.includes(from)) {
        s = s.split(from).join(to);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(fullPath, s);
      console.log('[postinstall] patched', label);
    }
  } catch (e) {
    console.warn('[postinstall] failed to patch', label, '-', e.message);
  }
}

// Health Connect: bump connect-client to stable version
patch(
  'node_modules/@devmaxime/capacitor-health-connect/android/build.gradle',
  [['1.1.0-alpha11', '1.1.0']],
  '@devmaxime/capacitor-health-connect'
);
