import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, mkdir, copyFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const runtimeFiles = await readJson(join(root, 'tools/runtime-files.json'));

test('Git install manifest and all transitive runtime dependencies live at repository root', async () => {
    const manifest = await readJson(join(root, 'manifest.json'));
    const metadata = await readJson(join(root, 'package.json'));
    assert.equal(manifest.js, 'index.js');
    assert.equal(manifest.css, 'style.css');
    assert.equal(manifest.version, metadata.version);
    assert.equal(manifest.author, 'weibaozi');
    assert.equal(manifest.homePage, 'https://github.com/weibaozi/Sillytavern-BreezeTTS');
    assert.equal(runtimeFiles.length, new Set(runtimeFiles).size);
    const visited = new Set(['manifest.json']);
    const pending = [manifest.js, manifest.css];
    while (pending.length) {
        const filename = pending.pop();
        if (visited.has(filename)) continue;
        assert.ok(runtimeFiles.includes(filename), `${filename} must be installed and packaged`);
        assert.ok((await stat(join(root, filename))).isFile(), `${filename} must exist`);
        visited.add(filename);
        const source = await readFile(join(root, filename), 'utf8');
        const patterns = filename.endsWith('.js') ? [
            /\b(?:import|export)\s+(?:[^'";]+?\s+from\s*)?['"]([^'"]+)['"]/g,
            /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
        ] : [
            /@import\s+['"]([^'"]+)['"]/g,
            /url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g,
        ];
        for (const pattern of patterns) {
            for (const match of source.matchAll(pattern)) {
                const dependency = match[1];
                if (/^(?:data:|https?:|#)/.test(dependency)) continue;
                const path = relative(root, resolve(root, dirname(filename), dependency)).replaceAll('\\', '/');
                assert.ok(!path.startsWith('..') && !isAbsolute(path), `${dependency} escapes the extension`);
                pending.push(path);
            }
        }
    }
    assert.ok(visited.has('panel.css'), 'Shadow DOM stylesheet must be included in dependency closure');
    assert.deepEqual([...visited].sort(), [...runtimeFiles].sort(), 'Runtime list must exclude development files');
});

test('manual installer requires opt-in and copies only runtime files with backup', { skip: process.platform !== 'win32' }, async t => {
    const fixture = await mkdtemp(join(tmpdir(), 'breeze-install-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const source = join(fixture, 'source');
    const tavern = join(fixture, 'SillyTavern');
    const destination = join(tavern, 'data/default-user/extensions/sillytavern-breeze');
    await mkdir(join(source, 'tools'), { recursive: true });
    await mkdir(join(tavern, 'public/scripts'), { recursive: true });
    await mkdir(join(tavern, 'data/default-user'), { recursive: true });
    await writeFile(join(tavern, 'public/scripts/st-context.js'), '// Fixture host marker');
    for (const name of [...runtimeFiles, 'install.ps1', 'tools/runtime-files.json']) {
        await copyFile(join(root, name), join(source, name));
    }
    await writeFile(join(source, 'development-only.js'), '// Must not be installed');
    const install = (...args) => spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'install.ps1'),
        '-SillyTavernPath', tavern, ...args,
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const refused = install();
    assert.notEqual(refused.status, 0, 'Experimental install must require explicit opt-in');
    assert.match(refused.stderr, /InstallExperimental/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
    const preview = install('-InstallExperimental', '-WhatIf');
    assert.equal(preview.status, 0, preview.stderr);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
    const installed = install('-InstallExperimental');
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual((await readdir(destination)).sort(), [...runtimeFiles].sort());
    for (const name of runtimeFiles) {
        assert.deepEqual(await readFile(join(destination, name)), await readFile(join(root, name)));
    }
    await writeFile(join(destination, 'index.js'), '// Old installed copy');
    const updated = install('-InstallExperimental');
    assert.equal(updated.status, 0, updated.stderr);
    const backups = await readdir(join(source, 'backups'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(source, 'backups', backups[0], 'sillytavern-breeze/index.js'), 'utf8'), '// Old installed copy');
    assert.deepEqual(await readFile(join(destination, 'index.js')), await readFile(join(root, 'index.js')));
    await copyFile(join(source, 'install.ps1'), join(destination, 'install.ps1'));
    const selfInstall = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(destination, 'install.ps1'),
        '-SillyTavernPath', tavern, '-InstallExperimental',
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.notEqual(selfInstall.status, 0);
    assert.match(selfInstall.stderr, /separate checkout/);
    await assert.rejects(stat(join(destination, 'backups')), { code: 'ENOENT' });
});
