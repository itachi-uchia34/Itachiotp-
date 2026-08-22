const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');

test('dashboard masks displayed numbers and keeps full numbers for copying', () => {
  assert.match(html, /function maskPhone\(value\)/);
  assert.match(html, /\+\$\{escapeHtml\(maskPhone\(item\.phone\)\)\}/);
  assert.match(html, /data-copy-value="\$\{escapeHtml\(`\+\$\{item\.phone\}`\)\}"/);
});
