import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { resolveRoot } from '../src/core/archive.ts'

/**
 * Root selection decides where `data/` and `personas/` are written. The case
 * that matters is the installed package: a fixed two-level walk from
 * `node_modules/@zmairc/persona-forge/dist/core/` lands inside `node_modules`,
 * so personas would be deleted by the next install.
 */

const checkout = join(resolve('C:/work'), 'persona-forge', 'src', 'core')
const packaged = join(resolve('C:/work'), 'node_modules', '@zmairc', 'persona-forge', 'dist', 'core')
const cwd = join(resolve('C:/work'), 'my-project')

test('a checkout resolves to the repository root', () => {
  assert.equal(resolveRoot({}, checkout, cwd), resolve(checkout))
})

test('an installed package resolves to the working directory, not node_modules', () => {
  assert.equal(resolveRoot({}, packaged, cwd), resolve(cwd))
})

test('PERSONAFORGE_ROOT overrides both', () => {
  const override = join(resolve('C:/work'), 'elsewhere')
  assert.equal(resolveRoot({ PERSONAFORGE_ROOT: override }, packaged, cwd), override)
  assert.equal(resolveRoot({ PERSONAFORGE_ROOT: override }, checkout, cwd), override)
})

test('a blank PERSONAFORGE_ROOT is ignored', () => {
  assert.equal(resolveRoot({ PERSONAFORGE_ROOT: '   ' }, checkout, cwd), resolve(checkout))
})
