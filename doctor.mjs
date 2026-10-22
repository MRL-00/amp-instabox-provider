import { spawnSync } from 'node:child_process';
import { Sandbox } from '@insforge/instabox-sdk';
import { loadConfig } from './config.mjs';

try {
  const config = await loadConfig();
  const version = spawnSync(config.ampBin, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error('Amp is not executable at ampBin');
  console.log(`Amp: ${version.stdout.trim()}`);
  const help = spawnSync(config.ampBin, ['orb', 'provider', '--help'], { encoding: 'utf8' });
  if (help.status !== 0 || !help.stdout.includes('ORB_OPERATION')) throw new Error('Update Amp to a version with orb provider support');
  const connection = { apiKey: config.instaboxApiKey };
  const machines = await Sandbox.list({ ...connection, metadata: { 'amp-provider': config.providerId } });
  const usage = await Sandbox.usage(connection);
  console.log(`Instabox API reachable. Provider machines: ${machines.length}. Account machines: ${usage.machines}/${usage.limits.maxMachines}.`);
  console.log('Read-only checks passed. This check does not start a VM or test the Amp provider token; the effective Instabox idle timer is logged on spawn.');
} catch (error) {
  console.error(`Check failed${error.code ? ` (${error.code})` : ''}. Check the private configuration and account permissions.`);
  process.exitCode = 1;
}
