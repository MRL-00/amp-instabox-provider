import { spawn } from 'node:child_process';
import { dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

try {
  const config = await loadConfig();
  const env = {
    ...process.env,
    PATH: [dirname(process.execPath), dirname(config.ampBin), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH || ''].join(delimiter),
    INSTABOX_API_KEY: config.instaboxApiKey,
    AMP_ORB_PROVIDER_TOKEN: config.ampProviderToken,
    INSTABOX_PROVIDER_ID: config.providerId,
    INSTABOX_TEMPLATE: config.template,
  };
  const child = spawn(config.ampBin, ['orb', 'provider', fileURLToPath(new URL('./dispatch.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env,
    stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => {
    console.error('Could not start Amp; check ampBin in config.json');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : code ?? 1;
  });
} catch (error) {
  console.error(`Provider cannot start: ${error.code === 'ENOENT' ? 'Run npm run configure first' : error.message}`);
  process.exitCode = 1;
}
