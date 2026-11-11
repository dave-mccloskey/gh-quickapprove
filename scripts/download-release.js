import {execFileSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {chromeVersion} from './release-version.js';

const release = process.env.RELEASE_NAME;
chromeVersion(release);
const info = JSON.parse(
  execFileSync('gh', ['release', 'view', release, '--json', 'tagName,isDraft,isPrerelease'], {
    encoding: 'utf8',
  }),
);
if (info.tagName !== release || info.isDraft || info.isPrerelease)
  throw new Error('Select a finalized release.');
execFileSync('git', ['merge-base', '--is-ancestor', release, 'HEAD'], {stdio: 'inherit'});
await mkdir('dist/submission', {recursive: true});
execFileSync(
  'gh',
  [
    'release',
    'download',
    release,
    '--dir',
    'dist/submission',
    '--pattern',
    `gh-quickapprove-${release}.zip`,
    '--pattern',
    'SHA256SUMS',
  ],
  {stdio: 'inherit'},
);
