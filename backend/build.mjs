// Bundles each Lambda and the CLI into single ESM files with esbuild.
//   dist/lambda/{api,prepare,merge}.mjs  -> zipped by Terraform (handler: <name>.handler)
//   dist/cli/loadtest.mjs                -> the `loadtest` command
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const requireShim = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";
const common = { bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: false, minify: false, legalComments: 'none', logLevel: 'warning' };

rmSync('dist', { recursive: true, force: true });

await build({
  ...common,
  entryPoints: {
    api: 'src/functions/api/handler.ts',
    prepare: 'src/functions/prepare/handler.ts',
    merge: 'src/functions/merge/handler.ts',
  },
  outdir: 'dist/lambda',
  outExtension: { '.js': '.mjs' },
  banner: { js: requireShim },
  // pdfkit reads its font files from disk at run time, so it ships as a normal dependency.
  external: ['pdfkit'],
});
writeFileSync('dist/lambda/package.json', JSON.stringify({ type: 'module', private: true, dependencies: { pdfkit: '^0.17.2' } }, null, 2));
execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock --silent', { cwd: 'dist/lambda', stdio: 'inherit' });

mkdirSync('dist/cli', { recursive: true });
await build({
  ...common,
  entryPoints: { loadtest: 'src/cli/loadtest.ts' },
  outdir: 'dist/cli',
  outExtension: { '.js': '.mjs' },
  banner: { js: '#!/usr/bin/env node' },
});
execSync('chmod +x dist/cli/loadtest.mjs');
console.log('built dist/lambda (api, prepare, merge) and dist/cli/loadtest.mjs');
