/**
 * FCM push notification utility using Firebase Admin SDK.
 *
 * Requires the env var FIREBASE_SERVICE_ACCOUNT_JSON to be set with the
 * contents of your Firebase project's service account JSON file.
 *
 * If the env var is absent the function logs and returns silently — useful
 * during local dev without Firebase configured.
 */

import admin from 'firebase-admin';

let initialized = false;

function initFirebase() {
  if (initialized) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return;
  try {
    const serviceAccount = JSON.parse(raw) as admin.ServiceAccount;
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    initialized = true;
  } catch (err) {
    console.error('[FCM] Failed to initialize Firebase Admin:', err);
  }
}

/**
 * Send a push notification to a list of FCM device tokens.
 * Fires-and-forgets — never throws.
 */
export async function notifyChefs(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  initFirebase();

  if (tokens.length === 0) return;

  if (!initialized) {
    console.log(
      `[FCM] Firebase not configured — skipping notification to ${tokens.length} device(s): "${title}"`,
    );
    return;
  }

  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data,
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });
    const failed = response.responses.filter((r) => !r.success).length;
    console.log(`[FCM] Sent ${response.successCount}/${tokens.length} notifications${failed ? ` (${failed} failed)` : ''}`);
  } catch (err) {
    console.error('[FCM] Send error:', err);
  }
}
