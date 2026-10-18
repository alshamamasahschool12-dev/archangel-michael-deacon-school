'use strict';

// Firebase Functions wrapper around the same direct-approval service used by
// the Vercel deployment. There is no attendance code, WhatsApp handoff, owner
// secret, or separate approver credential in this implementation.
const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const createAttendanceService = require('./attendance-core');

admin.initializeApp();
const service = createAttendanceService({admin});

exports.attendanceAccess = onRequest(
  {region: 'europe-west1', cors: false, maxInstances: 10},
  service.attendanceAccess,
);

exports.expireAttendanceAccess = onSchedule(
  {schedule: 'every 1 minutes', timeZone: 'Africa/Cairo', region: 'europe-west1'},
  service.expireAttendanceAccess,
);
