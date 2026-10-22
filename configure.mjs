import { readFile, writeFile, chmod } from 'node:fs/promises';
import { emitKeypressEvents } from 'node:readline';
import { configPath, loadConfig } from './config.mjs';

async function secret(prompt, previous) {
  if (!process.stdin.isTTY) throw new Error('Run configuration in an interactive terminal, or use ssh -t');
  process.stdout.write(`${prompt}${previous ? ' (Enter to keep existing)' : ''}: `);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value || previous || '');
    }
    function onKey(text, key = {}) {
      if (key.ctrl && key.name === 'c') return finish(new Error('Configuration cancelled'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') value = value.slice(0, -1);
      else if (text && !key.ctrl && !key.meta && !/[\r\n\0\x1b]/.test(text)) value += text;
    }
    process.stdin.on('keypress', onKey);
  });
}

try {
  let old = {};
  try {
    old = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const instaboxApiKey = await secret('Instabox API key', old.instaboxApiKey);
  const ampProviderToken = await secret('Amp custom provider token', old.ampProviderToken);
  if (!instaboxApiKey.startsWith('ibk_') || !ampProviderToken.startsWith('aop_live_')) {
    throw new Error('Expected an ibk_ Instabox key and an aop_live_ Amp provider token; nothing saved');
  }
  await writeFile(configPath, `${JSON.stringify({
    ...old, providerId: old.providerId || 'amp-instabox', instaboxApiKey, ampProviderToken,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  await loadConfig();
  console.log('Saved private config.json. Run npm run install-service to start the provider.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
