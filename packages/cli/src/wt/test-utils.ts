import { execSync } from 'node:child_process';
import path from 'node:path';

export function cloneBareAndCheckout(
  tmpDir: string,
  repoDir: string,
  cloneName = 'clone',
): { bareDir: string; cloneDir: string } {
  const bareDir = path.join(tmpDir, 'remote.git');
  const cloneDir = path.join(tmpDir, cloneName);
  execSync(`git clone --bare ${repoDir} ${bareDir}`);
  execSync(`git clone ${bareDir} ${cloneDir}`);
  execSync('git config user.email "t@t.com"', { cwd: cloneDir });
  execSync('git config user.name "T"', { cwd: cloneDir });
  return { bareDir, cloneDir };
}
