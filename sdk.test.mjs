import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox } from '@insforge/instabox-sdk';
import { dispatch, jobFromEnvironment } from './core.mjs';

test('published SDK translates the full create/pause/resume/delete lifecycle correctly', async () => {
  const requests = [];
  let machine;
  const connection = {
    apiKey: 'ibk_test-api-only',
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const method = options.method;
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ method, path, body });
      let result;
      if (method === 'GET' && path === '/v1/templates') result = { templates: [{ id: 'agent-browser' }] };
      else if (method === 'GET' && path === '/v1/machines') result = { machines: machine ? [machine] : [], nextCursor: null };
      else if (method === 'POST' && path === '/v1/machines') {
        machine = {
          ...body, id: 'm_sdk_test', state: 'running', operationId: null,
          template: { id: 'agent-browser' }, runtime: { ready: true },
          storage: { synced: true }, createdAt: '2026-10-22T00:00:00Z',
        };
        result = { id: 'op_create', machineId: machine.id, state: 'succeeded' };
      } else if (method === 'GET' && path === '/v1/machines/m_sdk_test') result = machine;
      else if (method === 'PATCH' && path === '/v1/machines/m_sdk_test') {
        Object.assign(machine, body);
        result = machine;
      } else if (method === 'POST' && path === '/v1/machines/m_sdk_test/exec') {
        result = { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false };
      } else if (method === 'POST' && /\/(suspend|resume)$/.test(path)) {
        machine.state = path.endsWith('/suspend') ? 'suspended' : 'running';
        result = { id: 'op_change', machineId: machine.id, state: 'succeeded' };
      } else if (method === 'DELETE' && path === '/v1/machines/m_sdk_test') {
        result = { id: 'op_delete', machineId: machine.id, state: 'succeeded' };
        machine = undefined;
      } else throw new Error(`Unexpected SDK request: ${method} ${path}`);
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  const job = jobFromEnvironment({
    ORB_OPERATION: 'spawn', ORB_ID: 'amp-T-sdk', INSTABOX_PROVIDER_ID: 'sdk-test',
    INSTABOX_API_KEY: connection.apiKey, ORB_TOKEN: 'first-token', ORB_IMAGE: 'example/amp:latest',
  });
  const log = () => {};
  await dispatch(job, Sandbox, connection, log);
  await dispatch({ ...job, operation: 'pause' }, Sandbox, connection, log);
  assert.equal(machine.state, 'suspended');
  await dispatch({ ...job, token: 'second-token' }, Sandbox, connection, log);
  assert.equal(machine.state, 'running');
  await dispatch({ ...job, operation: 'delete' }, Sandbox, connection, log);
  assert.equal(machine, undefined);
  assert.equal(requests.filter((r) => r.method === 'POST' && r.path === '/v1/machines').length, 1);
  assert.equal(requests.filter((r) => r.path.endsWith('/resume')).length, 1);
  const execs = requests.filter((r) => r.path.endsWith('/exec'));
  assert.equal(execs[0].body.envs.ORB_TOKEN, 'first-token');
  assert.equal(execs[2].body.envs.ORB_TOKEN, 'second-token');
  assert.equal(execs.some((r) => JSON.stringify(r.body).includes(connection.apiKey)), false);
  assert.equal(requests.find((r) => r.method === 'POST' && r.path === '/v1/machines').body.autoSuspendAfterSeconds, 0);
});
