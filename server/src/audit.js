const { ActivityLog } = require('./models');

function safeSummary(value) {
  return String(value || '').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 240);
}

async function audit(req, event) {
  return ActivityLog.create({
    hotelId: req.user.hotelId,
    actorId: req.user._id,
    actorName: safeSummary(req.user.name).slice(0, 80),
    actorRole: req.user.role,
    action: event.action,
    entityType: event.entityType,
    entityId: String(event.entityId),
    summary: safeSummary(event.summary),
    reason: event.reason ? safeSummary(event.reason) : undefined,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus
  });
}

module.exports = { audit };
