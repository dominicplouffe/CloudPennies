// Error -> ScanWarning classification. Pure; never includes credentials (AWS error messages contain ARNs at most).
import type { ScanWarning } from '../../src/core/types';

export interface ErrLike {
  name?: string;
  code?: string;
  Code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

const asErr = (e: unknown): ErrLike => (e && typeof e === 'object' ? (e as ErrLike) : { message: String(e) });
export const errName = (e: unknown): string => {
  const x = asErr(e);
  return x.name && x.name !== 'Error' ? x.name : (x.code ?? x.Code ?? x.name ?? 'Error');
};
export const errMessage = (e: unknown): string => asErr(e).message ?? String(e);

const ACCESS_NAMES = /AccessDenied|UnauthorizedOperation|UnauthorizedAccess|NotAuthorized|AuthorizationError|Forbidden/i;
const ACCESS_MSG = /not authorized to perform|is not authorized|access denied|explicit deny/i;
const CRED_NAMES = /UnrecognizedClient|InvalidClientTokenId|ExpiredToken|RequestExpired|SignatureDoesNotMatch|InvalidSignature|AuthFailure|CredentialsProviderError|TokenProviderError|IncompleteSignature/i;
const THROTTLE = /Throttl|TooManyRequests|LimitExceeded|RequestLimitExceeded|Rate exceeded/i;
const NETWORK = /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|TimeoutError|NetworkingError|socket hang up|getaddrinfo/i;
const OPT_IN = /opt[- ]?in|opted in|not enrolled|enroll|not enabled|is not subscribed|not subscribed|must be enabled|has not been enabled|not activated|not registered/i;
const NO_DATA = /DataUnavailable/i;

export function isAccessDenied(e: unknown): boolean {
  return ACCESS_NAMES.test(errName(e)) || ACCESS_MSG.test(errMessage(e)) || asErr(e).$metadata?.httpStatusCode === 403;
}
export const isDataUnavailable = (e: unknown): boolean => NO_DATA.test(errName(e)) || NO_DATA.test(errMessage(e));
export const isOptIn = (e: unknown): boolean => OPT_IN.test(errMessage(e)) || /OptInRequired/i.test(errName(e));
export const isValidation = (e: unknown): boolean => /Validation|InvalidParameter/i.test(errName(e));

/** Pull `service:Action` out of an IAM denial message, if present. */
export function deniedAction(message: string): string | undefined {
  const m = /not authorized to perform:?\s+([a-z0-9-]+:[A-Za-z0-9*]+)/i.exec(message);
  return m?.[1];
}

/** What each opt-in feature is called and how to switch it on. */
const FEATURES: Record<string, { name: string; how: string }> = {
  'cost-optimization-hub': {
    name: 'Cost Optimization Hub',
    how: 'Enable it for free in the Billing and Cost Management console under Cost Optimization Hub → Settings.',
  },
  rightsizing: {
    name: 'EC2 rightsizing recommendations',
    how: 'Enable them in Cost Explorer → Preferences (from the management account); results appear within 24 hours.',
  },
  anomalies: {
    name: 'Cost Anomaly Detection',
    how: 'Create a monitor in Billing and Cost Management → Cost Anomaly Detection to get AWS-detected anomalies.',
  },
  costs: {
    name: 'Cost Explorer',
    how: 'Enable Cost Explorer in the Billing and Cost Management console; data becomes available within 24 hours.',
  },
};

/**
 * Turn any thrown error into a user-facing warning for `section`.
 * `action` is the IAM action the failing call needs; it is used when AWS does not name it in the message.
 */
export function classifyError(section: string, e: unknown, action?: string): ScanWarning {
  const name = errName(e);
  const msg = errMessage(e);
  const feature = FEATURES[section];

  // Opt-in / not-enabled first: several services report it with an AccessDeniedException.
  const explicitDeny = /not authorized to perform|explicit deny/i.test(msg);
  if (!explicitDeny && (isOptIn(e) || (feature && /SubscriptionRequired/i.test(name)))) {
    return feature
      ? { section, message: `${feature.name} is not enabled for this account. ${feature.how}` }
      : { section, message: `This feature is not enabled for the account: ${oneLine(msg)}` };
  }
  if (isAccessDenied(e)) {
    const perm = deniedAction(msg) ?? action;
    return {
      section,
      message: perm ? `Access denied: ${perm}` : `Access denied: ${oneLine(msg)}`,
      ...(perm ? { missingPermission: perm } : {}),
    };
  }
  if (isDataUnavailable(e)) {
    return { section, message: 'AWS has no data for this yet. New accounts and newly enabled features can take 24 hours or more.' };
  }
  if (CRED_NAMES.test(name)) {
    return { section, message: 'AWS rejected the credentials (expired, disabled or invalid). Reconnect in Settings.' };
  }
  if (THROTTLE.test(name) || THROTTLE.test(msg)) {
    return { section, message: 'AWS throttled this request repeatedly. Run the scan again in a minute.' };
  }
  if (NETWORK.test(name) || NETWORK.test(msg) || NETWORK.test(String(asErr(e).code ?? ''))) {
    return { section, message: 'Could not reach AWS. Check the network connection and try again.' };
  }
  return { section, message: `${name}: ${oneLine(msg)}` };
}

/** Shown when Cost Explorer's resource-level data (an opt-in preference) is switched off. */
export const RESOURCE_LEVEL_DISABLED_MESSAGE =
  "Resource-level cost data is not enabled for this account. Turn on 'Resource-level data at daily granularity' in Billing → Cost Management preferences (free), wait up to 48 hours, then try again.";

/**
 * Error to show for a failed GetCostAndUsageWithResources call. AWS reports the missing opt-in as a
 * DataUnavailableException or as an access-denied error that is not an IAM denial; everything else keeps
 * its usual friendly classification.
 */
export function resourceCostError(e: unknown): Error {
  const msg = errMessage(e);
  const iamDenial = /not authorized to perform|explicit deny/i.test(msg);
  const notEnabled = !iamDenial && !CRED_NAMES.test(errName(e)) && (isDataUnavailable(e) || isOptIn(e) || isAccessDenied(e));
  return new Error(notEnabled ? RESOURCE_LEVEL_DISABLED_MESSAGE : classifyError('resource-costs', e, 'ce:GetCostAndUsageWithResources').message);
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 240 ? t.slice(0, 237) + '…' : t;
}

/** Collects warnings, keeping at most one per (section, missing permission / message). */
export class WarningSink {
  private seen = new Set<string>();
  readonly list: ScanWarning[] = [];
  add(w: ScanWarning): void {
    const key = w.missingPermission ? `perm:${w.missingPermission}` : `${w.section}|${w.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push(w);
  }
}

// ── connection errors (STS validation) ──

export function friendlyConnectError(e: unknown, kind: 'keys' | 'profile'): string {
  const name = errName(e);
  const msg = errMessage(e);
  if (/InvalidClientTokenId|UnrecognizedClient/i.test(name)) return "AWS doesn't recognize that access key ID. Check it for typos, and that the key is still active.";
  if (/SignatureDoesNotMatch|InvalidSignature/i.test(name)) return "The secret access key doesn't match the access key ID. Paste it again, watching for missing characters.";
  if (/ExpiredToken|RequestExpired/i.test(name)) {
    return kind === 'profile'
      ? 'The credentials for this profile have expired. Refresh them (for SSO: `aws sso login --profile <name>`) and try again.'
      : 'These temporary credentials have expired. Paste a fresh set.';
  }
  if (/CredentialsProviderError|TokenProviderError/i.test(name) || /could not (be found|resolve)|profile .* (not|could not)/i.test(msg)) {
    return kind === 'profile'
      ? `Could not load credentials from that profile: ${oneLine(msg)}`
      : `Could not use those credentials: ${oneLine(msg)}`;
  }
  if (isAccessDenied(e)) return 'The credentials are valid but are denied sts:GetCallerIdentity (an explicit deny or SCP). Ask your administrator.';
  if (NETWORK.test(name) || NETWORK.test(msg)) return 'Could not reach AWS. Check your internet connection (or proxy/VPN) and try again.';
  return `Could not connect: ${oneLine(msg)}`;
}

/** AKIAIOSFODNN7EXAMPLE -> AKIA…MPLE */
export function maskKeyId(id: string): string {
  const s = id.trim();
  if (s.length <= 8) return s.slice(0, 2) + '…';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
