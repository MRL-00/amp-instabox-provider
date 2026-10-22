import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dispatch, jobFromEnvironment, startCommand, stopCommand, withLock } from './core.mjs';

const environment = {
  ORB_OPERATION: 'spawn', ORB_ID: 'amp-T-example', INSTABOX_PROVIDER_ID: 'mini',
  INSTABOX_API_KEY: 'ibk_test', ORB_TOKEN: 'fresh-test-token',
  ORB_IMAGE: 'registry.example/amp/orb@sha256:abcdef',
};

function fixture(state, extra = []) {
  const job = jobFromEnvironment(environment);
  const calls = [];
  const machines = state ? [{ sandboxId: 'm_test', metadata: job.metadata, state }, ...extra] : extra;
  const machine = {
    sandboxId: 'm_test',
    setAutoSuspend: async (ms) => calls.push(['autoSuspend', ms]),
    getInfo: async () => ({ state }),
    pause: async () => calls.push(['pause']),
    commands: { run: async (...args) => calls.push(['run', ...args]) },
  };
  const sdk = {
    list: async (options) => { calls.push(['list', options]); return machines; },
    create: async (...args) => { calls.push(['create', ...args]); return machine; },
    connect: async (...args) => { calls.push(['connect', ...args]); return machine; },
    kill: async (...args) => calls.push(['kill', ...args]),
  };
  const logs = [];
  return { job, calls, sdk, machine, logs, log: (line) => logs.push(line) };
}

test('new orb is isolated, Vault disabled, with fresh token passed through environment', async () => {
  const f = fixture();
  await dispatch(f.job, f.sdk, {}, f.log);
  const create = f.calls.find(([type]) => type === 'create');
  assert.equal(create[1], 'agent-browser');
  assert.equal(create[2].vault, false);
  assert.equal(create[2].autoSuspendMs, 0);
  const run = f.calls.find(([type]) => type === 'run');
  assert.equal(run[2].envs.ORB_TOKEN, environment.ORB_TOKEN);
  assert.equal(run[1].includes(environment.ORB_TOKEN), false);
  assert.equal(f.logs.join('').includes(environment.ORB_TOKEN), false);
});

test('resume finds the same VM and forwards the replacement token', async () => {
  const f = fixture('suspended');
  await dispatch({ ...f.job, token: 'rotated-token' }, f.sdk, {}, f.log);
  assert.equal(f.calls.some(([type]) => type === 'create'), false);
  assert.deepEqual(f.calls.find(([type]) => type === 'connect'), ['connect', 'm_test', {}]);
  assert.equal(f.calls.find(([type]) => type === 'run')[2].envs.ORB_TOKEN, 'rotated-token');
});

test('pause stops container before suspending VM and never resumes it', async () => {
  const f = fixture('running');
  await dispatch({ ...f.job, operation: 'pause' }, f.sdk, {}, f.log);
  assert.equal(f.calls.find(([type]) => type === 'connect')[2].resume, false);
  assert.ok(f.calls.findIndex(([type]) => type === 'run') < f.calls.findIndex(([type]) => type === 'pause'));
  assert.equal(f.calls.find(([type]) => type === 'run')[1], stopCommand);
});

test('duplicate pause does no guest commands or lifecycle changes', async () => {
  for (const state of ['suspended', 'stopped']) {
    const f = fixture(state);
    await dispatch({ ...f.job, operation: 'pause' }, f.sdk, {}, f.log);
    assert.equal(f.calls.some(([type]) => ['run', 'pause', 'create'].includes(type)), false);
  }
});

test('delete never wakes or connects to the VM and missing deletes succeed', async () => {
  for (const state of ['suspended', undefined]) {
    const f = fixture(state);
    await dispatch({ ...f.job, operation: 'delete' }, f.sdk, {}, f.log);
    assert.equal(f.calls.some(([type]) => ['connect', 'run', 'create'].includes(type)), false);
    assert.equal(f.calls.some(([type]) => type === 'kill'), Boolean(state));
  }
});

test('a listing failure cannot create a second VM', async () => {
  const f = fixture();
  f.sdk.list = async () => { throw new Error('network unavailable'); };
  await assert.rejects(dispatch(f.job, f.sdk, {}, f.log), /network unavailable/);
  assert.equal(f.calls.some(([type]) => type === 'create'), false);
});

test('failed startup pauses the VM and preserves the original error', async () => {
  const f = fixture();
  f.machine.commands.run = async () => { throw new Error('image download failed'); };
  await assert.rejects(dispatch(f.job, f.sdk, {}, f.log), /image download failed/);
  assert.ok(f.calls.some(([type]) => type === 'pause'));
  assert.equal(f.calls.some(([type]) => type === 'kill'), false);
});

test('an enforced Instabox idle timer is reported without blocking startup', async () => {
  const f = fixture('suspended');
  f.machine.getInfo = async () => ({ state: 'running', autoSuspendMs: 1_800_000 });
  await dispatch(f.job, f.sdk, {}, f.log);
  assert.ok(f.logs.some((line) => line.includes('30-minute idle timer')));
  assert.ok(f.calls.some(([type]) => type === 'run'));
  assert.equal(f.calls.some(([type]) => type === 'autoSuspend'), false);
});

test('ambiguous ownership refuses deletion and unrelated machines are ignored', async () => {
  const f = fixture('running');
  f.sdk.list = async () => [
    { sandboxId: 'm_1', metadata: f.job.metadata, state: 'running' },
    { sandboxId: 'm_2', metadata: f.job.metadata, state: 'running' },
  ];
  await assert.rejects(dispatch({ ...f.job, operation: 'delete' }, f.sdk, {}, f.log), /Multiple machines/);
  assert.equal(f.calls.length, 0);
  const unrelated = fixture(undefined, [{ sandboxId: 'm_personal', metadata: {}, state: 'running' }]);
  await dispatch({ ...unrelated.job, operation: 'delete' }, unrelated.sdk, {}, unrelated.log);
  assert.equal(unrelated.calls.some(([type]) => type === 'kill'), false);
});

test('pause/delete require neither a bootstrap token nor an image', () => {
  for (const operation of ['pause', 'delete']) {
    const env = { ...environment, ORB_OPERATION: operation };
    delete env.ORB_TOKEN;
    delete env.ORB_IMAGE;
    assert.equal(jobFromEnvironment(env).operation, operation);
  }
});

test('invalid jobs and executable image injection are rejected', () => {
  for (const change of [
    { ORB_OPERATION: 'destroy-everything' }, { ORB_TOKEN: '' },
    { ORB_ID: '../other' }, { ORB_IMAGE: 'image; touch /tmp/injected' },
    { INSTABOX_PROVIDER_ID: '../provider' }, { AMP_URL: 'http://insecure.example' },
  ]) assert.throws(() => jobFromEnvironment({ ...environment, ...change }));
});

test('shell commands parse and keep token values out of shell source', () => {
  execFileSync('/bin/sh', ['-n'], { input: startCommand });
  execFileSync('/bin/sh', ['-n'], { input: stopCommand });
  assert.ok(startCommand.includes('--env ORB_TOKEN="$ORB_TOKEN"'));
});

test('concurrent jobs for one orb serialize and release their lock after failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amp-instabox-lock-'));
  const events = [];
  try {
    await Promise.all([
      withLock(dir, 'orb', async () => { events.push('first-start'); await delay(80); events.push('first-end'); }),
      delay(20).then(() => withLock(dir, 'orb', async () => events.push('second'))),
    ]);
    assert.deepEqual(events, ['first-start', 'first-end', 'second']);
    await assert.rejects(withLock(dir, 'orb', async () => { throw new Error('failed'); }));
    await withLock(dir, 'orb', async () => events.push('after-error'));
    assert.equal(events.at(-1), 'after-error');
    await writeFile(join(dir, 'orb.lock'), '2147483647');
    await withLock(dir, 'orb', async () => events.push('recovered'));
    assert.equal(events.at(-1), 'recovered');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
