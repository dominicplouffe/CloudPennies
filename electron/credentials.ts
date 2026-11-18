// Credential + settings storage in the app's userData directory. Secrets are never logged.
import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromIni } from '@aws-sdk/credential-providers';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { DEFAULT_SETTINGS, type ConnectionInfo, type CostBasis, type CredentialInput, type Settings } from '../src/core/types';
import { friendlyConnectError, maskKeyId } from './aws/errors';

interface KeySecrets {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

type Stored =
  | {
      kind: 'keys';
      /** masked key id, safe to show */
      label: string;
      encrypted: boolean;
      /** base64: safeStorage ciphertext when `encrypted`, otherwise UTF-8 JSON */
      secret: string;
      accountId: string;
      arn: string;
    }
  | { kind: 'profile'; profile: string; accountId: string; arn: string };

export interface ResolvedConnection {
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  identity: { accountId: string; arn?: string };
}

const dataDir = () => app.getPath('userData');
const credentialsPath = () => path.join(dataDir(), 'credentials.json');
const settingsPath = () => path.join(dataDir(), 'settings.json');
export const cacheDir = () => path.join(dataDir(), 'cache');

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function seal(secrets: KeySecrets): { encrypted: boolean; secret: string } {
  const json = JSON.stringify(secrets);
  if (encryptionAvailable()) return { encrypted: true, secret: safeStorage.encryptString(json).toString('base64') };
  return { encrypted: false, secret: Buffer.from(json, 'utf8').toString('base64') };
}

function unseal(s: Extract<Stored, { kind: 'keys' }>): KeySecrets | null {
  try {
    const buf = Buffer.from(s.secret, 'base64');
    const json = s.encrypted ? safeStorage.decryptString(buf) : buf.toString('utf8');
    const v = JSON.parse(json) as KeySecrets;
    return v.accessKeyId && v.secretAccessKey ? v : null;
  } catch {
    return null; // e.g. the OS keychain entry is gone; the user has to reconnect
  }
}

async function readStored(): Promise<Stored | null> {
  const s = await readJson<Stored>(credentialsPath());
  if (!s || (s.kind !== 'keys' && s.kind !== 'profile')) return null;
  return s;
}

function toInfo(s: Stored): ConnectionInfo {
  return s.kind === 'keys'
    ? { connected: true, kind: 'keys', label: s.label, accountId: s.accountId, arn: s.arn, encrypted: s.encrypted }
    : { connected: true, kind: 'profile', label: s.profile, accountId: s.accountId, arn: s.arn, encrypted: false };
}

export async function getConnection(): Promise<ConnectionInfo> {
  const s = await readStored();
  if (!s) return { connected: false };
  if (s.kind === 'keys' && !unseal(s)) return { connected: false };
  return toInfo(s);
}

/** Credentials + identity for the saved connection, or null when not connected. */
export async function resolveConnection(): Promise<ResolvedConnection | null> {
  const s = await readStored();
  if (!s) return null;
  const identity = { accountId: s.accountId, arn: s.arn };
  if (s.kind === 'profile') return { credentials: fromIni({ profile: s.profile }), identity };
  const k = unseal(s);
  if (!k) return null;
  return {
    credentials: { accessKeyId: k.accessKeyId, secretAccessKey: k.secretAccessKey, ...(k.sessionToken ? { sessionToken: k.sessionToken } : {}) },
    identity,
  };
}

export async function listProfiles(): Promise<string[]> {
  try {
    const { configFile, credentialsFile } = await loadSharedConfigFiles();
    const names = new Set<string>([...Object.keys(credentialsFile ?? {}), ...Object.keys(configFile ?? {})]);
    return [...names].filter((n) => n && !n.includes('sso-session') && !n.startsWith('services ')).sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
  } catch {
    return [];
  }
}

export async function connect(input: CredentialInput): Promise<{ ok: true; info: ConnectionInfo } | { ok: false; error: string }> {
  let credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  let secrets: KeySecrets | undefined;
  if (input?.kind === 'keys') {
    const accessKeyId = String(input.accessKeyId ?? '').trim();
    const secretAccessKey = String(input.secretAccessKey ?? '').trim();
    const sessionToken = input.sessionToken ? String(input.sessionToken).trim() : '';
    if (!/^[A-Z0-9]{16,128}$/.test(accessKeyId)) return { ok: false, error: 'That does not look like an access key ID. It should be 20 capital letters and digits, starting with AKIA or ASIA.' };
    if (secretAccessKey.length < 20) return { ok: false, error: 'The secret access key looks too short. Paste the full 40-character secret.' };
    if (accessKeyId.startsWith('ASIA') && !sessionToken) return { ok: false, error: 'Keys starting with ASIA are temporary and need their session token as well.' };
    secrets = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
    credentials = secrets;
  } else if (input?.kind === 'profile') {
    const profile = String(input.profile ?? '').trim();
    if (!profile) return { ok: false, error: 'Choose a profile.' };
    credentials = fromIni({ profile });
  } else {
    return { ok: false, error: 'Unknown credential type.' };
  }

  // Validate before anything is written to disk.
  const sts = new STSClient({ region: 'us-east-1', credentials, maxAttempts: 2 });
  let accountId: string;
  let arn: string;
  try {
    const id = await sts.send(new GetCallerIdentityCommand({}));
    if (!id.Account) return { ok: false, error: 'AWS did not return an account for these credentials.' };
    accountId = id.Account;
    arn = id.Arn ?? '';
  } catch (e) {
    return { ok: false, error: friendlyConnectError(e, input.kind) };
  } finally {
    sts.destroy();
  }

  try {
    const stored: Stored = secrets
      ? { kind: 'keys', label: maskKeyId(secrets.accessKeyId), ...seal(secrets), accountId, arn }
      : { kind: 'profile', profile: (input as { profile: string }).profile.trim(), accountId, arn };
    await writePrivate(credentialsPath(), stored);
    return { ok: true, info: toInfo(stored) };
  } catch {
    return { ok: false, error: 'The credentials are valid, but they could not be saved on this computer.' };
  }
}

/** Forget the credentials and every cached byte of billing data. */
export async function disconnect(): Promise<void> {
  await fs.rm(credentialsPath(), { force: true }).catch(() => undefined);
  await fs.rm(cacheDir(), { recursive: true, force: true }).catch(() => undefined);
}

// ── settings ──

const COST_BASES: CostBasis[] = ['UnblendedCost', 'AmortizedCost', 'NetAmortizedCost'];
const THEMES: Settings['theme'][] = ['system', 'light', 'dark'];

/** Merge untrusted input over the defaults, keeping only well-typed values. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    ...DEFAULT_SETTINGS,
    ...(COST_BASES.includes(r.costBasis as CostBasis) ? { costBasis: r.costBasis as CostBasis } : {}),
    ...(typeof r.deepScan === 'boolean' ? { deepScan: r.deepScan } : {}),
    ...(typeof r.anomalyMinImpact === 'number' && Number.isFinite(r.anomalyMinImpact) && r.anomalyMinImpact >= 0 ? { anomalyMinImpact: r.anomalyMinImpact } : {}),
    ...(THEMES.includes(r.theme as Settings['theme']) ? { theme: r.theme as Settings['theme'] } : {}),
  };
}

export async function getSettings(): Promise<Settings> {
  return sanitizeSettings(await readJson<unknown>(settingsPath()));
}

export async function saveSettings(s: Settings): Promise<void> {
  await writePrivate(settingsPath(), sanitizeSettings(s));
}
