/**
 * Best-effort detection of storage that may vanish (private browsing, no persistence grant).
 * There is no reliable API for "incognito"; small quotas are the usual tell.
 */
export interface StorageStatus {
  persisted: boolean;
  likelyPrivate: boolean;
}

export async function checkStorage(): Promise<StorageStatus> {
  let persisted = false;
  let likelyPrivate = false;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false;
    if (!persisted) persisted = (await navigator.storage?.persist?.()) ?? false;
    const est = await navigator.storage?.estimate?.();
    // Chromium incognito and Safari private mode report quotas far below normal profiles.
    if (est?.quota !== undefined && est.quota < 200 * 1024 * 1024) likelyPrivate = true;
  } catch {
    likelyPrivate = true;
  }
  return { persisted, likelyPrivate };
}
