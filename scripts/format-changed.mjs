#!/usr/bin/env node
/**
 * Runs Prettier on the files changed in the working tree (staged, unstaged and
 * untracked, per `git status`) instead of the whole repository.
 *
 * The existing codebase was never reformatted wholesale, so a repo-wide
 * `prettier --check .` fails on dozens of files nobody touched. Scoping to the
 * current changes keeps `npm run format` / `npm run format:check` usable on a
 * clean checkout: files adopt the Prettier style when you change them, and
 * lint-staged formats staged files at commit time.
 *
 * Usage: node scripts/format-changed.mjs [--write]   (default is --check)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { extname } from 'node:path';

const write = process.argv.includes('--write');

const PRETTIER_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.md',
  '.yml',
  '.yaml',
]);

const status = execFileSync(
  'git',
  ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'],
  { encoding: 'utf8' },
);

const files = status
  .split('\0')
  .filter(Boolean)
  .filter((entry) => !entry.slice(0, 2).includes('D')) // skip deleted paths
  .map((entry) => entry.slice(3))
  .filter((path) => PRETTIER_EXTENSIONS.has(extname(path)));

if (files.length === 0) {
  console.log('No changed files to check with Prettier.');
  process.exit(0);
}

// Prettier still applies .prettierignore to this explicit list.
const result = spawnSync('prettier', [write ? '--write' : '--check', ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
