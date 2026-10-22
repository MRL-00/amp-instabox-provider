import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const label = 'com.github.mrl-00.amp-instabox-provider';
const root = fileURLToPath(new URL('.', import.meta.url));
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

try {
  if (process.platform !== 'darwin') throw new Error('This installer is for macOS');
  await loadConfig();
  await chmod(new URL('./dispatch.mjs', import.meta.url), 0o700);
  await mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 });
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root, 'service.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(root, 'logs', 'provider.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, 'logs', 'provider-error.log'))}</string>
</dict></plist>
`;
  await writeFile(plistPath, plist, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  const session = spawnSync('/bin/launchctl', ['print', domain], { stdio: 'ignore' });
  if (session.status !== 0) throw new Error('Log into the macOS desktop once, then run this installer again');
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  const result = spawnSync('/bin/launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('launchctl bootstrap failed');
  console.log(`Started ${label}. Logs: ${join(root, 'logs')}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
