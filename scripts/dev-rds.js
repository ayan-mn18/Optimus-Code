import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';

const execFileAsync = promisify(execFile);
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: [path.join(backendRoot, '.env.local'), path.join(backendRoot, '.env')] });

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-south-1';
const instanceId = process.env.RDS_SSM_INSTANCE_ID ?? 'i-0e0f6f5503ee50d48';
const remoteHost = process.env.RDS_REMOTE_HOST ?? 'optimus-prod-db.cpea6oe6avbw.ap-south-1.rds.amazonaws.com';
const remotePort = String(process.env.RDS_REMOTE_PORT ?? '5432');
const localHost = process.env.DATABASE_HOST ?? '127.0.0.1';
const localPort = String(process.env.DATABASE_PORT ?? '15432');
const secretId = process.env.RDS_SECRET_ID ?? 'optimus/prod/rds-app';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitForTunnel(tunnel) {
  const deadline = Date.now() + 20_000;
  let tunnelExit;
  tunnel.once('exit', (code, signal) => {
    tunnelExit = { code, signal };
  });

  while (Date.now() < deadline) {
    if (await canConnect(localHost, localPort)) return;
    if (tunnelExit) {
      throw new Error(`SSM tunnel exited before it opened (code=${tunnelExit.code}, signal=${tunnelExit.signal ?? 'none'}).`);
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for the local RDS tunnel on ${localHost}:${localPort}.`);
}

async function readRdsSecret() {
  const { stdout } = await execFileAsync('aws', [
    'secretsmanager',
    'get-secret-value',
    '--region',
    region,
    '--secret-id',
    secretId,
    '--query',
    'SecretString',
    '--output',
    'text',
  ], { maxBuffer: 128 * 1024 });

  const secret = JSON.parse(stdout);
  if (!secret.password || !secret.username || !secret.dbname) {
    throw new Error(`Secret ${secretId} is missing username, password, or dbname.`);
  }
  return secret;
}

const secret = await readRdsSecret();
const tunnel = spawn('aws', [
  'ssm',
  'start-session',
  '--region',
  region,
  '--target',
  instanceId,
  '--document-name',
  'AWS-StartPortForwardingSessionToRemoteHost',
  '--parameters',
  JSON.stringify({
    host: [remoteHost],
    portNumber: [remotePort],
    localPortNumber: [localPort],
  }),
], { stdio: 'inherit' });

let app;
const cleanup = () => {
  if (app && !app.killed) app.kill('SIGTERM');
  if (!tunnel.killed) tunnel.kill('SIGTERM');
};

process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);

try {
  await waitForTunnel(tunnel);
  console.log(`RDS tunnel ready at ${localHost}:${localPort}; starting Optimus API.`);

  app = spawn(process.execPath, ['--watch', 'src/server.js'], {
    cwd: backendRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      DB_DRIVER: 'native',
      DATABASE_HOST: localHost,
      DATABASE_PORT: localPort,
      DATABASE_NAME: secret.dbname,
      DATABASE_USER: secret.username,
      DATABASE_PASSWORD: secret.password,
      DATABASE_SSL: 'true',
    },
  });

  const [code, signal] = await new Promise((resolve) => {
    app.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  cleanup();
  process.exitCode = code ?? (signal ? 1 : 0);
} catch (error) {
  cleanup();
  console.error(`Unable to start local RDS development: ${error.message}`);
  console.error('Install the AWS Session Manager Plugin and ensure your AWS identity can use SSM and read the RDS app secret.');
  process.exitCode = 1;
}
