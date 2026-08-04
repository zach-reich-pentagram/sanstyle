// Loads the app's classic scripts into a fresh Node vm realm so the exact
// files that ship to the browser are what gets unit-tested.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE = ['util.js', 'geometry.js', 'fitcurves.js', 'raster.js', 'trace.js', 'fitting.js', 'ttf.js'];

function loadST(files) {
  const sandbox = { console };
  const ctx = vm.createContext(sandbox);
  for (const f of files || CORE) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  return vm.runInContext('globalThis.ST', ctx);
}

module.exports = { loadST };
