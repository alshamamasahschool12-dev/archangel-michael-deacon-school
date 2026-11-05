'use strict';

// Existing Cloud Functions for attendance access, plus admin-only FCM push.
const { onRequest } = require('firebase-functions/v2/https');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onValueCreated } = require('firebase-functions/v2/database');
const { defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('node:crypto');
const createAttendanceService = require('./attendance-core');

admin.initializeApp();
const service = createAttendanceService({ admin });
const FCM_ADMIN_UID = defineString('FCM_ADMIN_UID', {
  description: 'Firebase Auth UID of the one school administrator allowed to register web push devices.'
});
const messaging = admin.messaging();

exports.attendanceAccess = onRequest(
  { region: 'europe-west1', cors: false, maxInstances: 10 },
  service.attendanceAccess,
);

exports.expireAttendanceAccess = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'Africa/Cairo', region: 'europe-west1' },
  service.expireAttendanceAccess,
);

// The callable accepts only the explicitly allow-listed Firebase Auth account.
// RTDB rules can stay locked; Admin SDK writes this private token registry.
exports.registerAdminWebPushToken = onCall(
  { region: 'europe-west1', maxInstances: 3 },
  async (request) => {
    const expectedUid = FCM_ADMIN_UID.value();
    if (!request.auth || request.auth.uid !== expectedUid) {
      throw new HttpsError('permission-denied', 'الحساب غير مصرح له بتسجيل جهاز الإشعارات.');
    }
    const token = request.data && request.data.token;
    if (typeof token !== 'string' || token.length < 50 || token.length > 4096) {
      throw new HttpsError('invalid-argument', 'رمز الإشعارات غير صالح.');
    }
    const key = crypto.createHash('sha256').update(token).digest('hex');
    await admin.database().ref(`_privateFcmAdminTokens/${expectedUid}/${key}`).set({
      token,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
      platform: 'web'
    });
    return { ok: true };
  },
);

// Notify only when a new request record is created in pending state.
// Updates to approval/revocation fields do not send more notifications.
exports.notifyAdminOnNewAttendanceRequest = onValueCreated(
  {
    ref: 'attendance-approval-v4-private/requests/{requestId}',
    instance: 'alshamamasahschool-default-rtdb',
    region: 'europe-west1',
    maxInstances: 5,
  },
  async (event) => {
    const request = event.data.val();
    if (!request || request.status !== 'pending') return;

    const uid = FCM_ADMIN_UID.value();
    const tokenRef = admin.database().ref(`_privateFcmAdminTokens/${uid}`);
    const snapshot = await tokenRef.get();
    if (!snapshot.exists()) return;

    const entries = Object.entries(snapshot.val() || {});
    const tokens = entries.map(([, value]) => value && value.token).filter(Boolean);
    if (!tokens.length) return;

    const result = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: 'طلب موافقة جديد',
        body: 'وصل طلب جديد يحتاج مراجعة المسؤول.'
      },
      data: {
        type: 'attendance_request',
        requestId: String(event.params.requestId),
        url: '/shamamsa-admin.html'
      },
      webpush: {
        notification: {
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: `attendance-request-${event.params.requestId}`,
          renotify: false
        },
        fcmOptions: {
          link: 'https://archangel-michael-deacon-school.vercel.app/shamamsa-admin.html'
        }
      }
    });

    const deletes = [];
    result.responses.forEach((response, index) => {
      const code = response.error && response.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        deletes.push(tokenRef.child(entries[index][0]).remove());
      }
    });
    await Promise.all(deletes);
  },
);
