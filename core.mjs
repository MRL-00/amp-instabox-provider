import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const docker = `set -eu
docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    sudo -n docker "$@"
  fi
}
`;

export const startCommand = `${docker}
if ! docker_cmd container inspect "$AMP_CONTAINER" >/dev/null 2>&1; then
  docker_cmd run --init --platform linux/amd64 -d --name "$AMP_CONTAINER" "$ORB_IMAGE" sleep infinity >/dev/null
fi
docker_cmd start "$AMP_CONTAINER" >/dev/null
docker_cmd exec "$AMP_CONTAINER" sh -c 'if [ -s /tmp/amp-provider-bootstrap.pid ]; then p=$(cat /tmp/amp-provider-bootstrap.pid); if [ -r "/proc/$p/cmdline" ] && tr "\\000" " " < "/proc/$p/cmdline" | grep -q "amp orb bootstrap"; then kill "$p"; fi; fi'
docker_cmd exec -d --env ORB_TOKEN="$ORB_TOKEN" --env AMP_URL="$AMP_URL" "$AMP_CONTAINER" sh -c 'echo $$ > /tmp/amp-provider-bootstrap.pid; exec amp orb bootstrap'
`;

export const stopCommand = `${docker}
if docker_cmd container inspect "$AMP_CONTAINER" >/dev/null 2>&1; then
  docker_cmd stop --time 15 "$AMP_CONTAINER" >/dev/null
fi
`;

function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`${key} must be set to a nonempty, single-line value`);
  }
  return value;
}

export function jobFromEnvironment(env) {
  const operation = required(env, 'ORB_OPERATION');
  if (!['spawn', 'pause', 'delete'].includes(operation)) throw new Error('Unsupported ORB_OPERATION');
  const orbId = required(env, 'ORB_ID');
  const providerId = required(env, 'INSTABOX_PROVIDER_ID');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(orbId)) throw new Error('Invalid ORB_ID');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(providerId)) throw new Error('Invalid INSTABOX_PROVIDER_ID');
  required(env, 'INSTABOX_API_KEY');
  const job = {
    operation,
    orbId,
    providerId,
    metadata: { 'amp-provider': providerId, 'amp-orb': orbId },
    name: `amp-${createHash('sha256').update(`${providerId}:${orbId}`).digest('hex').slice(0, 32)}`,
    template: env.INSTABOX_TEMPLATE || 'agent-browser',
    snapshotRequested: Boolean(env.ORB_SNAPSHOT_ID),
  };
  if (operation === 'spawn') {
    job.token = required(env, 'ORB_TOKEN');
    job.image = required(env, 'ORB_IMAGE');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/.test(job.image)) throw new Error('Invalid ORB_IMAGE');
    job.ampUrl = env.AMP_URL || 'https://ampcode.com';
    if (new URL(job.ampUrl).protocol !== 'https:') throw new Error('AMP_URL must use HTTPS');
  }
  return job;
}

export async function withLock(directory, key, fn) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${key}.lock`);
  let handle;
  const deadline = Date.now() + 240_000;
  while (!handle) {
    try {
      handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(file, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
          } catch (probeError) {
            if (probeError.code === 'ESRCH') await unlink(file).catch(() => {});
          }
        } else if (Date.now() - (await stat(file)).mtimeMs > 5_000) {
          await unlink(file).catch(() => {});
        }
      } catch (readError) {
        if (readError.code !== 'ENOENT') throw readError;
      }
      if (Date.now() > deadline) throw new Error('Another job for this orb still holds its lock');
      await delay(250);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await unlink(file).catch(() => {});
  }
}

export async function dispatch(job, Sandbox, connection, log = console.log) {
  const matches = (await Sandbox.list({ ...connection, metadata: job.metadata }))
    .filter((machine) => Object.entries(job.metadata).every(([key, value]) => machine.metadata[key] === value))
    .filter((machine) => machine.state !== 'deleted');
  if (matches.length > 1) throw new Error('Multiple machines match this orb; refusing an ambiguous operation');
  const existing = matches[0];
  if (job.operation === 'delete') {
    if (existing) await Sandbox.kill(existing.sandboxId, connection);
    log(existing ? `Deleted ${existing.sandboxId}` : 'Orb machine is already absent');
    return;
  }
  if (job.operation === 'pause') {
    if (!existing) {
      log('Orb machine is already absent');
      return;
    }
    const machine = await Sandbox.connect(existing.sandboxId, { ...connection, resume: false });
    const info = await machine.getInfo();
    if (info.state === 'running') {
      await machine.commands.run(stopCommand, { envs: { AMP_CONTAINER: job.name }, timeoutMs: 45_000 });
      await machine.pause();
    } else if (!['suspended', 'stopped'].includes(info.state)) {
      throw new Error(`Cannot pause machine in state ${info.state}`);
    }
    log(`Paused ${existing.sandboxId}`);
    return;
  }
  if (job.snapshotRequested) log('Project snapshot caching is disabled; each new orb runs project setup');
  const machine = existing
    ? await Sandbox.connect(existing.sandboxId, connection)
    : await Sandbox.create(job.template, {
      ...connection,
      name: job.name,
      metadata: job.metadata,
      vault: false,
      autoSuspendMs: 0,
    });
  try {
    const info = await machine.getInfo();
    if (info.autoSuspendMs) log(`Instabox enforces a ${info.autoSuspendMs / 60_000}-minute idle timer independently of Amp`);
    log(`${existing ? 'Resumed' : 'Created'} ${machine.sandboxId}; starting Amp orb`);
    await machine.commands.run(startCommand, {
      envs: {
        AMP_CONTAINER: job.name,
        ORB_IMAGE: job.image,
        ORB_TOKEN: job.token,
        AMP_URL: job.ampUrl,
      },
      timeoutMs: 180_000,
    });
  } catch (error) {
    try {
      await machine.pause();
      log(`Paused ${machine.sandboxId} after failed startup; its disk is preserved`);
    } catch {
      log(`Could not pause ${machine.sandboxId} after failed startup; check it in Instabox`);
    }
    throw error;
  }
  log(`Bootstrap launched on ${machine.sandboxId}`);
}
