#!/usr/bin/env node
/**
 * postinstall.js — patch third-party Capacitor plugins to work with our build.
 *
 * Some upstream plugins ship with stale versions or proguard config that fails
 * with newer Gradle / Android Studio. We patch them in-place after npm install
 * so we don't fork the plugins.
 *
 * Each patch is wrapped in try/catch so a missing file (e.g. plugin not yet
 * installed) doesn't break npm install.
 */
const fs = require('fs');
const path = require('path');

function patch(file, replacements, label) {
  try {
    const fullPath = path.join(process.cwd(), file);
    if (!fs.existsSync(fullPath)) return; // plugin not installed
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

// Health Connect: bump connect-client to stable + fix proguard
patch(
  'node_modules/@devmaxime/capacitor-health-connect/android/build.gradle',
  [
    ['1.1.0-alpha11', '1.1.0'],
    [`getDefaultProguardFile('proguard-android.txt')`, `getDefaultProguardFile('proguard-android-optimize.txt')`],
  ],
  '@devmaxime/capacitor-health-connect'
);

// Speech Recognition: fix proguard (uses deprecated proguard-android.txt)
patch(
  'node_modules/@capacitor-community/speech-recognition/android/build.gradle',
  [
    [`getDefaultProguardFile('proguard-android.txt')`, `getDefaultProguardFile('proguard-android-optimize.txt')`],
  ],
  '@capacitor-community/speech-recognition'
);
