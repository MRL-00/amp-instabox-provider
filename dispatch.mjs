#!/usr/bin/env node
import { Sandbox } from '@insforge/instabox-sdk';
import { fileURLToPath } from 'node:url';
import { dispatch, jobFromEnvironment, withLock } from './core.mjs';

const timer = setTimeout(() => {
  console.error('Provider job exceeded 275 seconds; inspect the machine before retrying');
  process.exit(1);
}, 275_000);

try {
  const job = jobFromEnvironment(process.env);
  const connection = {
    apiKey: process.env.INSTABOX_API_KEY,
    apiUrl: process.env.INSTABOX_API_URL || 'https://api.instabox.sh',
    operationTimeoutMs: 180_000,
  };
  await withLock(fileURLToPath(new URL('./state/', import.meta.url)), job.name,
    () => dispatch(job, Sandbox, connection));
} catch (error) {
  const secrets = [process.env.INSTABOX_API_KEY, process.env.AMP_ORB_PROVIDER_TOKEN, process.env.ORB_TOKEN].filter(Boolean);
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
  console.error(`Instabox adapter failed: ${message}`);
  if (error.code) console.error(`Code: ${error.code}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
