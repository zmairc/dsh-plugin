import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

/**
 * Guards the published package shape. Every assertion here exists because the
 * corresponding mistake already shipped once:
 *
 * - 0.1.2 was published with `"@zmairc/persona-forge": "file:zmairc-persona-forge-0.1.2.tgz"`
 *   in its own `dependencies` (left over from a local tarball test). pnpm in the
 *   DSH profile then tried to install that tarball from the profile directory and
 *   the whole install failed with "Could not install from ... .tgz as it does not exist".
 * - 0.1.0/0.1.1 pointed `main` at `src/dsh/plugin.ts`, which Node refuses to run
 *   from inside `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
 */
const manifestPath = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  name: string
  version: string
  main: string
  exports: Record<string, string>
  bin: Record<string, string>
  files: string[]
  dsh: { bundle: { patch: string } }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** Every dependency map, to audit for self references and local-only specs. */
const dependencyMaps = {
  dependencies: manifest.dependencies ?? {},
  devDependencies: manifest.devDependencies ?? {},
  peerDependencies: manifest.peerDependencies ?? {},
  optionalDependencies: manifest.optionalDependencies ?? {},
}

test('a package never depends on itself', () => {
  for (const [label, deps] of Object.entries(dependencyMaps)) {
    assert.equal(
      deps[manifest.name],
      undefined,
      `${label} 里出现了指向自己的 ${manifest.name}，发布会装出致命的自依赖`,
    )
  }
})

test('no dependency points at a local path or tarball', () => {
  for (const [label, deps] of Object.entries(dependencyMaps)) {
    for (const [name, spec] of Object.entries(deps)) {
      assert.ok(
        !/^(file|link|portal|workspace):/.test(spec) && !spec.endsWith('.tgz'),
        `${label}.${name} = ${spec}：本地路径/打包文件只在开发机上有效，发布后必然装不上`,
      )
    }
  }
})

test('the runtime entry is compiled output, never TypeScript source', () => {
  // Node refuses type stripping under node_modules, so the entry must be .js.
  assert.match(manifest.main, /^dist\/.*\.js$/, 'main 必须指向 dist 里的 .js')
  const exportEntry = manifest.exports['.']
  assert.ok(exportEntry, '缺少 exports["."]')
  assert.match(exportEntry, /^\.\/dist\/.*\.js$/, 'exports["."] 必须指向 dist 里的 .js')
  for (const [name, target] of Object.entries(manifest.bin)) {
    assert.match(target, /^dist\/.*\.js$/, `bin.${name} 必须指向 dist 里的 .js`)
  }
})

test('the published files include the built output and the bundle patch', () => {
  assert.ok(manifest.files.includes('dist'), 'files 必须包含 dist')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'files 必须包含 cordis.patch.yml')
  assert.ok(!manifest.files.includes('src'), 'files 不该包含 src（Node 不会在 node_modules 里剥离 TS）')
})

test('the declared DSH bundle patch exists in the repo', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const patchUrl = new URL(manifest.dsh.bundle.patch, manifestPath)
  assert.ok(existsSync(patchUrl), `dsh.bundle.patch 指向的 ${manifest.dsh.bundle.patch} 不存在`)
})

test('the version is a plain semver string', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
})
