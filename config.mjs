import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const configPath = new URL('./config.json', import.meta.url);

export async function loadConfig() {
  const info = await stat(configPath);
  if ((info.mode & 0o077) !== 0) throw new Error('config.json must be private: chmod 600 config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  for (const key of ['instaboxApiKey', 'ampProviderToken', 'providerId']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`Missing ${key} in config.json`);
  }
  if (!config.instaboxApiKey.startsWith('ibk_')) throw new Error('Instabox API keys start with ibk_');
  if (!config.ampProviderToken.startsWith('aop_live_')) throw new Error('Amp provider tokens start with aop_live_');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(config.providerId)) throw new Error('Invalid providerId');
  return {
    ...config,
    ampBin: config.ampBin || join(homedir(), '.local/bin/amp'),
    template: config.template || 'agent-browser',
  };
}
