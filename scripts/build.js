'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();

  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursiveSync(
        path.join(src, childItemName),
        path.join(dest, childItemName)
      );
    });
  } else if (exists) {
    const parentDir = path.dirname(dest);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
  }
}

// Clean and create dist directory
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// Copy static assets and entry points
copyRecursiveSync(path.join(ROOT_DIR, 'index.html'), path.join(DIST_DIR, 'index.html'));
copyRecursiveSync(path.join(ROOT_DIR, 'assets'), path.join(DIST_DIR, 'assets'));
copyRecursiveSync(path.join(ROOT_DIR, 'server'), path.join(DIST_DIR, 'server'));

if (fs.existsSync(path.join(ROOT_DIR, 'firebase-applet-config.json'))) {
  copyRecursiveSync(
    path.join(ROOT_DIR, 'firebase-applet-config.json'),
    path.join(DIST_DIR, 'firebase-applet-config.json')
  );
}

if (fs.existsSync(path.join(ROOT_DIR, 'metadata.json'))) {
  copyRecursiveSync(
    path.join(ROOT_DIR, 'metadata.json'),
    path.join(DIST_DIR, 'metadata.json')
  );
}

console.log('Build complete: generated dist/ directory successfully.');
