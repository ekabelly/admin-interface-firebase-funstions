const admin = require('firebase-admin');
const errCodes = require('../config/error-codes');
const { fetchSnapshot } = require('../util/app-util');
const { errHandler } = require('../middlewares/app-middlewares');
const db = admin.database();

const assignEntityToReq = async (req, entityName, id, dbRef) => {
    const entity = await fetchSnapshot(req, db.ref(`/${entityName}s/${id}`));
    if (!entity) {
        req.err = {
            code: errCodes.INVALID_PARAMS,
            message: `${entityName} not found.`
        };
        return false;
    }
    req[entityName] = entity;
}

const fetchEventsByIdArr = async (req, eventsIdDictionary) => {
    const promisesArr = [];
    // console.log(eventsIdArr);
    for (const eventId of Object.values(eventsIdDictionary)) {
        let promise = fetchSnapshot(req, db.ref(`/events/${eventId}`));
        promisesArr.push(promise);
    }
    const eventsArr = await Promise.all(promisesArr);
    return eventsArr;
}

const fetchEvents = async (req, res, next) => {
    req.data = await fetchSnapshot(req, db.ref('/events'));
    return next();
}

const fetchUserEvents = async (req, res, next) => {
    const eventsIdArr = await fetchSnapshot(req, db.ref(`/users/${req.params.userId}/${req.eventsType /* this is registeredEvents, pastEvents, backupEvents or savedEvents */}`));
    if (!eventsIdArr || eventsIdArr.length < 1) {
        req.err = "this user has no events of type " + req.eventsType;
        return next();
    }
    req.data = await fetchEventsByIdArr(req, eventsIdArr);
    next();
}

const fetchEvent = async (req, res, next) => {
    req.data = await fetchSnapshot(req, db.ref(`/events/${req.params.eventId}`));
    next();
}

const registerUserToEventConditions = (userId, req) => {
    if (req.event.assignedVolunteers[userId]) {
        req.err = {
            code: errCodes.ALREADY_REGISTERED,
            message: `volunteer already registered to event.`
        };
        return false;
    }
    if (Object.keys(req.event.assignedVolunteers).length >= req.event.volunteers.max) {
        req.err = {
            code: errCodes.EVENT_FULL,
            message: `event already full. can't register to a full events. user may register to waiting list.`
        };
        // on this case, user is allowed to register to backup list
    }
    return true;
}

const addUserIdToEvent = async (userId, eventId, req) => {
    let volunteersCollection = 'assignedVolunteers';
    if (!req.event.assignedVolunteers) {
        req.event.assignedVolunteers = {};
    }
    if (!req.event.backupVolunteers) {
        req.event.backupVolunteers = {};
    }
    const isAllowed = registerUserToEventConditions(userId, req);
    if (!isAllowed) {
        return false;
    } else if ((req.err && req.err.code === errCodes.EVENT_FULL) || req.isBackupVolunteer) {
        volunteersCollection = 'backupVolunteers';
        req.didRegisterAsBackup = true;
        req.event.backupVolunteers[userId] = userId;
    } else {
        req.event.assignedVolunteers[userId] = userId;
    }
    return new Promise(resolve => db.ref(`/events/${eventId}/${volunteersCollection}`)
        .set(req.event[volunteersCollection]).then(() => resolve(true)).catch(err => {
            req.err = err;
            resolve(false);
        }));
}

const addEventIdToUser = async (userId, eventId, req) => {
    let eventType = 'registeredEvents';
    if (!req.user.registeredEvents) {
        req.user.registeredEvents = {};
    }
    if (!req.user.backupEvents) {
        req.user.backupEvents = {};
    }
    if ((req.err && req.err.code === errCodes.EVENT_FULL) || req.isBackupVolunteer) {
        eventType = 'backupEvents';
        req.didRegisterAsBackup = true;
    }
    if (req.user[eventType][eventId]) {
        return false;
    }
    req.user[eventType][eventId] = eventId;
    return new Promise(resolve => db.ref(`/users/${userId}/${eventType}`)
        .set(req.user[eventType]).then(() => resolve(true)).catch(err => {
            req.err = err;
            resolve(false);
        }));
}

const registerUserToEvent = async (req, res, next) => {
    await assignEntityToReq(req, 'event', req.params.eventId);
    await assignEntityToReq(req, 'user', req.params.userId);
    const didRegisterUserToEvent = await addUserIdToEvent(req.params.userId, req.params.eventId, req);
    let didAddEventToUser = false;
    if (didRegisterUserToEvent) {
        didAddEventToUser = await addEventIdToUser(req.params.userId, req.params.eventId, req);
    }
    if (req.didRegisterAsBackup && req.err && req.err.code === errCodes.EVENT_FULL) {
        req.err = null;
    }
    req.data = { didRegisterUserToEvent, didAddEventToUser, didRegisterAsBackup: req.didRegisterAsBackup };
    next();
}

const assignUserToBackup = async (req, res, next) => {
    req.isBackupVolunteer = true;
    registerUserToEvent(req, res, next);
}

const removeUserIdFromEvent = async (userId, eventId, collectionName, req) => {
    const event = await fetchSnapshot(req, db.ref(`/events/${eventId}`));
    if (event[collectionName] || !!event[collectionName][userId]) {
        delete event[collectionName][userId];
        return new Promise(resolve => db.ref(`/events/${eventId}/${collectionName}`)
            .set(event[collectionName]).then(() => resolve(true)).catch(err => {
                req.err = err;
                resolve(false);
            }));
    } else {
        req.err = {
            message: 'user not registered to that event.',
            code: errCodes.UNKNOWN_ERROR
        }
        return false;
    }
}

const removeEventIdFromUser = async (userId, eventId, collectionName, req) => {
    const user = await fetchSnapshot(req, db.ref(`/users/${userId}`));
    if (user[collectionName]) {
        if (user[collectionName][eventId]) {
            delete user[collectionName][eventId];
            return new Promise(resolve => db.ref(`/users/${userId}/${collectionName}`)
                .set(user[collectionName]).then(() => resolve(true)).catch(err => {
                    req.err = err;
                    resolve(false);
                }));
        }
    } else {
        req.err = {
            message: 'user not registered to that event.',
            code: errCodes.UNKNOWN_ERROR
        }
        return false;
    }
}

const unregisterUserFromEvent = async (req, res, next) => {
    const didRemoveUserFromEvent = await removeUserIdFromEvent(req.params.userId, req.params.eventId, 'assignedVolunteers', req);
    let didRemoveEventFromUser = false;
    if (didRemoveUserFromEvent) {
        didRemoveEventFromUser = await removeEventIdFromUser(req.params.userId, req.params.eventId, 'registeredEvents', req);
    } else {
        req.err = {
            message: 'something went wrong.',
            code: errCodes.UNKNOWN_ERROR
        }
    }
    req.data = { didRemoveUserFromEvent, didRemoveEventFromUser };
    next();
}

const unregisterUserFromEventBackup = async (req, res, next) => {
    const didRemoveUserFromEvent = await removeUserIdFromEvent(req.params.userId, req.params.eventId, 'backupVolunteers', req);
    let didRemoveEventFromUser = false;
    if (didRemoveUserFromEvent) {
        didRemoveEventFromUser = await removeEventIdFromUser(req.params.userId, req.params.eventId, 'backupEvents', req);
    } else {
        req.err = {
            message: 'something went wrong.',
            code: errCodes.UNKNOWN_ERROR
        }
    }
    req.data = { didRemoveUserFromEvent, didRemoveEventFromUser };
    next();
}

const createEvent = (req, res, next) => {
    const newEvent = db.ref('/events').push();
    req.body.event.id = newEvent.key;
    newEvent.set(req.body.event).then(() => {
        req.data = { success: true };
        return next();
    }).catch(errHandler);
}

const updateEvent = (req, res, next) => {
    const eventToUpdate = db.ref(`/events/${req.params.eventId}`);
    eventToUpdate.set(req.body.event).then(() => {
        req.data = { success: true };
        return next();
    }).catch(errHandler);
}

const addEventToUserSavedEvents = async (req, res, next) => {
    await assignEntityToReq(req, 'event', req.params.eventId);
    await assignEntityToReq(req, 'user', req.params.userId);
    if (req.err) {
        return next();
    }
    if (!req.user.savedEvents) {
        req.user.savedEvents = {};
    }
    if (req.user.savedEvents[req.params.eventId]) {
        delete req.user.savedEvents[req.params.eventId];
    } else {
        req.user.savedEvents[req.params.eventId] = req.params.eventId;
    }
    const valueToUpdateRef = db.ref(`/users/${req.params.userId}/savedEvents`);
    valueToUpdateRef.set(req.user.savedEvents).then(() => {
        req.data = { isEventSaved: req.user.savedEvents[req.params.eventId] ? true : false };
        next();
    }).catch(errHandler);
}

const finishEvent = async (req, res, next) => {
    await assignEntityToReq(req, 'event', req.params.eventId);
    if (req.err) {
        return next();
    }
    const valueToUpdateRef = db.ref(`/events/${req.params.eventId}/isDone`);
    valueToUpdateRef.set(true).then(() => {
        req.data = { isDone: true };
        next();
    }).catch(errHandler);
}

module.exports = {
    updateEvent,
    createEvent,
    fetchEvent,
    fetchEvents,
    finishEvent,
    fetchUserEvents,
    registerUserToEvent,
    unregisterUserFromEvent,
    unregisterUserFromEventBackup,
    addEventToUserSavedEvents,
    assignUserToBackup
}