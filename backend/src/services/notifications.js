const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function sendPushNotification({ pushToken, title, body, data = {} }) {
  if (!pushToken || !pushToken.startsWith('ExponentPushToken')) return { status: 'skipped', reason: 'invalid token' };
  try {
    const resp = await fetch(EXPO_PUSH_URL, { method: 'POST', headers: { Accept: 'application/json', 'Accept-encoding': 'gzip, deflate', 'Content-Type': 'application/json' }, body: JSON.stringify({ to: pushToken, sound: 'default', title, body, data }) });
    return await resp.json();
  } catch (err) { return { status: 'error', error: err.message }; }
}

async function notifyRowFilled({ pushToken, filledRowLabel, alternativeRow, lotId }) {
  return sendPushNotification({
    pushToken,
    title: `Row ${filledRowLabel} just filled`,
    body: alternativeRow ? `Row ${alternativeRow.label} has ${alternativeRow.open} spots — tap to reroute` : 'All rows are filling up — check alternatives nearby',
    data: { screen: 'reroute', lotId, newRowId: alternativeRow?.id, newRowLabel: alternativeRow?.label },
  });
}

module.exports = { sendPushNotification, notifyRowFilled };
