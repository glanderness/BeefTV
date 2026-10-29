#!/usr/bin/env node
// Static inventory only: repeated declarations are candidates, never deletion instructions.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const postcss = createRequire(path.join(root, 'web/package.json'))('postcss');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const allFiles = walk(path.join(root, 'web/src')).filter(f => f.endsWith('.css')).sort();
const excluded = allFiles.filter(f => /\/(pages|components|lib)\/(canvas|dev)\//.test(f));
const files = allFiles.filter(f => !excluded.includes(f));
const buckets = new Map();
const stats = [];
const isCanvas = s => /canvas-|data-canvas|react-flow|xyflow|tldraw|director-/.test(s) && !/canvas-collection|canvas-library|canvas-history|lib-tv-project|libtv-library|creation-|app-user-workspace|app-product-|app-workspace/.test(s);
for (const file of files) {
 const source = fs.readFileSync(file, 'utf8');
 const ast = postcss.parse(source, { from: file });
 const stat = { file: path.relative(root, file), lines: source.split('\n').length - 1, rules: 0, declarations: 0, important: 0, canvasOnlySelectorBranches: 0 };
 ast.walkRules(rule => {
  const ancestors = []; let parent = rule.parent;
  while (parent && parent.type !== 'root') { if (parent.type === 'atrule') ancestors.unshift(`@${parent.name} ${parent.params}`.trim()); parent = parent.parent; }
  if (ancestors.some(a => /keyframes/.test(a))) return;
  stat.rules++;
  const ds = (rule.nodes || []).filter(n => n.type === 'decl');
  stat.declarations += ds.length; stat.important += ds.filter(d => d.important).length;
  for (const raw of rule.selectors) {
   const selector = raw.replace(/\s+/g, ' ').trim();
   if (isCanvas(selector)) { stat.canvasOnlySelectorBranches++; continue; }
   for (const d of ds) {
    const context = ancestors.join(' > ') || '(unlayered root)';
    const key = JSON.stringify([context, selector, d.prop]);
    const entry = { file: stat.file, line: d.source.start.line, value: d.value, important: Boolean(d.important) };
    if (!buckets.has(key)) buckets.set(key, { context, selector, property: d.prop, declarations: [] });
    buckets.get(key).declarations.push(entry);
   }
  }
 });
 stats.push(stat);
}
const groups = [...buckets.values()].filter(g => g.declarations.length > 1).map(g => {
 const values = new Set(g.declarations.map(d => `${d.value}|${d.important}`));
 return { kind: values.size === 1 ? 'same-value-repeat' : 'value-override', ...g };
}).sort((a,b) => b.declarations.length-a.declarations.length || a.selector.localeCompare(b.selector) || a.property.localeCompare(b.property));
const result = {
 scope: 'All web/src CSS except canvas/dev directories; obvious canvas-only selector branches omitted from candidate groups. File counts still include mixed globals. Shared rules require manual boundary review.',
 limitations: 'Not a computed-style engine or unused-CSS detector. Does not expand shorthands, calculate specificity, resolve CSS variables, JS theme/inline styles, Tailwind classes, lazy-load timing or element matching. Same-value repeats can be intentional compatibility declarations.',
 fileCount: files.length, excludedFiles: excluded.map(f => path.relative(root,f)),
 totals: { rules: stats.reduce((n,s)=>n+s.rules,0), declarations: stats.reduce((n,s)=>n+s.declarations,0), important: stats.reduce((n,s)=>n+s.important,0), candidateGroups: groups.length, sameValueGroups: groups.filter(g=>g.kind==='same-value-repeat').length, overrideGroups: groups.filter(g=>g.kind==='value-override').length },
 files: stats, groups
};
process.stdout.write(JSON.stringify(result, null, 2)+'\n');
