#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const postcss = createRequire(path.join(root, 'web/package.json'))('postcss');

// Frozen inherited debt, not an approval of every declaration. No auto-update mode.
// Counts include mixed globals; scope/limitations remain in audit-outer-ui-styles.cjs.
const legacyBudgets = {
    'web/src/components/layout/workspace-account-card.css': { important: 3 },
    'web/src/components/onboarding/first-creation-guide.css': { important: 2 },
    'web/src/components/ui/fluid-orb.css': { important: 1 },
    'web/src/components/video-player.css': { important: 11 },
    'web/src/pages/create/creation-product.css': { important: 53, duplicates: 4 },
    'web/src/pages/home/home-dashboard.css': { important: 4 },
    'web/src/pages/plugins/plugins.css': { important: 2, duplicates: 4 },
    'web/src/pages/projects/detail/workflow.css': { important: 3, duplicates: 6 },
    'web/src/styles/assets-workspace.css': { important: 15, duplicates: 15 },
    'web/src/styles/beeftv-local-overrides.css': { important: 8 },
    'web/src/styles/globals.css': { important: 1065, duplicates: 880 },
    'web/src/styles/workspace-navigation.css': { important: 111, duplicates: 50 },
    'web/src/styles/workspace-page.css': { important: 31 },
    'web/src/styles/workspace-product.css': { important: 114, duplicates: 59 },
    'web/src/styles/asset-history-cards.css': { duplicates: 2 },
    'web/src/components/image-size-picker.css': { duplicates: 2 },
};
const owners = [
    { pattern: /\.app-workspace-(?:shell|main-row|stage|sidebar(?:-nav)?|nav-(?:link|title|icon))(?![\w-])/, files: ['web/src/styles/workspace-navigation.css'] },
    { pattern: /\.(?:app-page-header(?:-(?:title|actions))?|app-section-page-content)(?![\w-])/, files: ['web/src/styles/workspace-page.css'] },
    { pattern: /\.workspace-(?:controls-)?form(?![\w-])/, files: ['web/src/styles/workspace-controls.css', 'web/src/styles/workspace-ui.css'] },
];

function compositionException(file, selector, declaration) {
    if (declaration.important) return false;
    // The page owns flex allocation, not PageHeader appearance or spacing.
    if (file === 'web/src/pages/skills/marketplace.css') {
        const content = '.skill-market-page > .app-section-page-content';
        if (selector === content) return ({ display: 'flex', 'flex-direction': 'column', height: '100%', 'min-height': '0' })[declaration.prop] === declaration.value;
        if (selector === `${content} > .app-page-header` || selector === `${content} > .ant-tabs`) return declaration.prop === 'flex-shrink' && declaration.value === '0';
    }
    // Context selector adjusts the guide entry, not the shared sidebar itself.
    return file === 'web/src/components/onboarding/first-creation-guide.css'
        && selector === '.app-workspace-sidebar-nav.is-collapsed .first-creation-entry'
        && declaration.prop === 'margin-left' && declaration.value === '-2px';
}

function checkOwnership(file, source) {
    const errors = [];
    postcss.parse(source, { from: file }).walkRules(rule => {
        for (const branch of rule.selectors) {
            const selector = branch.replace(/\s+/g, ' ').trim();
            if (!owners.some(owner => owner.pattern.test(selector) && !owner.files.includes(file))) continue;
            for (const declaration of rule.nodes.filter(node => node.type === 'decl')) {
                if (!compositionException(file, selector, declaration)) errors.push(`${file}:${declaration.source.start.line}: shared owner violation: ${selector} / ${declaration.prop}`);
            }
        }
    });
    return errors;
}

function checkBudgets(report) {
    const errors = [];
    for (const file of report.files) {
        const limit = legacyBudgets[file.file]?.important ?? 0;
        if (file.important > limit) errors.push(`${file.file}: !important ${file.important} exceeds inherited budget ${limit}; explain and review the owning rule`);
    }
    const duplicates = new Map();
    for (const group of report.groups) for (const declaration of group.declarations) duplicates.set(declaration.file, (duplicates.get(declaration.file) ?? 0) + 1);
    for (const [file, count] of duplicates) {
        const limit = legacyBudgets[file]?.duplicates ?? 0;
        if (count > limit) errors.push(`${file}: repeated selector/property occurrences ${count} exceeds inherited budget ${limit}; inspect the inventory before changing rules`);
    }
    return errors;
}

module.exports = { checkOwnership, checkBudgets };
if (require.main === module) {
    const report = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'audit-outer-ui-styles.cjs')], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    const errors = [...checkBudgets(report), ...report.files.flatMap(file => checkOwnership(file.file, fs.readFileSync(path.join(root, file.file), 'utf8')))];
    if (errors.length) {
        console.error(errors.join('\n'));
        process.exitCode = 1;
    } else console.log(`Outer UI contract passed (${report.fileCount} CSS files; inherited debt retained, no runtime/UI proof).`);
}
