// Posting to a Slack incoming webhook. The URL is a secret: it is never logged or put in an error.
import { validateSlackWebhook } from './backgroundLogic';

const TIMEOUT_MS = 10_000;

/** Returns null on success, otherwise a short human-readable reason (never containing the URL). */
export async function postToSlack(webhookUrl: string, text: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const v = validateSlackWebhook(webhookUrl);
  if (!v.ok) return 'The saved Slack webhook is not valid. Paste it again in Settings.';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(v.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ctl.signal,
      redirect: 'error', // the secret path must not be replayed to another host
    });
    if (res.ok) return null;
    if (res.status === 404 || res.status === 410) return 'Slack says this webhook no longer exists. Create a new one and paste it in Settings.';
    if (res.status === 403) return 'Slack refused the message (403). The webhook may have been revoked.';
    if (res.status === 429) return 'Slack is rate-limiting this webhook. Try again in a minute.';
    return `Slack answered with an error (HTTP ${res.status}).`;
  } catch {
    return ctl.signal.aborted ? 'Slack did not answer within 10 seconds.' : 'Could not reach Slack. Check your internet connection.';
  } finally {
    clearTimeout(timer);
  }
}
