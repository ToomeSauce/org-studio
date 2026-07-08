/**
 * M-2 (#1663): per-channel legacy-path disable.
 *
 * `MESSAGING_NATIVE_CHANNELS` — comma-separated channel ids (e.g. "telegram")
 * for which the NATIVE adapter is authoritative and the legacy delivery path
 * (direct Telegram sends / OpenClaw chat.send relay) must be skipped, so a
 * message never lands twice.
 *
 * Default: empty — legacy paths keep working untouched (M-1 additive rule).
 * Fully reversible: unset the var and the legacy path resumes.
 */

export function nativeChannels(): Set<string> {
  return new Set(
    (process.env.MESSAGING_NATIVE_CHANNELS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when `channel`'s legacy delivery should be skipped in favor of the
 *  native messaging adapter. */
export function isLegacyChannelDisabled(channel: string): boolean {
  return nativeChannels().has(channel.toLowerCase());
}
