const { io } = require('socket.io-client');
const {
    SCSC_TAG,
    pickMostCommonFirstWord,
    stripScScTag,
    hasScScTag,
    buildSeedPrompt,
    buildNextPrompt,
    nextPollPayload,
    shouldEndLoopFromVotes
} = require('./words');

const MODES = new Set(['never', 'always', 'scsc']);
const DISCONNECT_GRACE_MS = 5000;
const CLASS_REFRESH_MS = 10000;
const DEFAULT_AUTO_END_SECONDS = 5;
const DEFAULT_AUTO_END_PERCENT = 80;

function normalizeClassId(value) {
    if (value == null || value === '' || value === false) return null;
    return value;
}

function classNameFromData(data) {
    if (!data || typeof data !== 'object') return null;
    return data.className || data.name || null;
}

function displayClassName(listener) {
    const data = listener.lastClassData;
    const name = classNameFromData(data);
    if (name) return name;
    const classId = data && data.id != null ? data.id : listener.classId;
    if (classId != null && classId !== '') return `Class ${classId}`;
    return null;
}

function requestActiveClass(listener) {
    const socket = listener.formbarSocket;
    if (!socket || !socket.connected) return;
    socket.emit('getActiveClass', listener.apiKey);
}

const listeners = new Map();

function getStudentText(pollRes) {
    if (!pollRes || typeof pollRes !== 'object') return '';
    const candidates = [pollRes.textRes, pollRes.text, pollRes.textResponse];
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return '';
}

function collectStudentTextResponses(students) {
    const textResponses = [];

    for (const student of Object.values(students || {})) {
        const response = getStudentText(student.pollRes);
        if (response) {
            textResponses.push({
                studentName: student.displayName || 'Student',
                response,
                firstWord: response.trim().split(/\s+/)[0] || ''
            });
        }
    }

    return textResponses;
}

function isPollActive(poll) {
    return Boolean(poll && poll.status !== false);
}

function isPollComplete(poll) {
    if (!isPollActive(poll)) return false;

    const totalResponses = Number(poll.totalResponses);
    const totalResponders = Number(poll.totalResponders);

    return Number.isFinite(totalResponses)
        && Number.isFinite(totalResponders)
        && totalResponses > 0
        && totalResponses >= totalResponders;
}

function responsePercent(poll) {
    const totalResponses = Number(poll && poll.totalResponses) || 0;
    const totalResponders = Number(poll && poll.totalResponders) || 0;
    if (totalResponders <= 0) return 0;
    return (totalResponses / totalResponders) * 100;
}

function pollKey(data) {
    if (!data || !data.poll) return null;
    return `${data.id || 'class'}::${data.poll.prompt || ''}`;
}

function getPollAnswerLabels(poll) {
    const responses = poll && poll.responses;
    if (!responses) return [];
    if (Array.isArray(responses)) {
        return responses
            .map((entry) => {
                if (entry == null) return '';
                if (typeof entry === 'string') return entry;
                return String(entry.answer != null ? entry.answer : '');
            })
            .filter(Boolean);
    }
    if (typeof responses === 'object') {
        return Object.keys(responses);
    }
    return [];
}

function isOurContinuationPoll(poll) {
    if (!poll || !poll.allowTextResponses) return false;
    const labels = getPollAnswerLabels(poll);
    if (labels.length < 1 || labels.length > 2) return false;
    const hasNext = labels.some((label) => /submit next word/i.test(label));
    if (!hasNext) return false;
    return labels.every(
        (label) => /submit next word/i.test(label) || /end response/i.test(label)
    );
}

function isMatchingPoll(poll, mode) {
    if (!isPollActive(poll)) return false;
    if (!poll.allowTextResponses) return false;
    if (mode === 'never') return false;
    if (mode === 'scsc') {
        return hasScScTag(poll.prompt) || isOurContinuationPoll(poll);
    }
    return true;
}

function clearAutoEndTimer(listener) {
    if (listener.autoEndTimer) {
        clearTimeout(listener.autoEndTimer);
        listener.autoEndTimer = null;
    }
    listener.autoEndDeadline = null;
    listener.autoEndForKey = null;
}

function endFormbarPoll(listener) {
    const socket = listener.formbarSocket;
    if (!socket || !socket.connected) return false;
    socket.emit('updatePoll', { status: false });
    return true;
}

function startNextWordPoll(listener, prompt) {
    const socket = listener.formbarSocket;
    if (!socket || !socket.connected) {
        emitError(listener, 'Formbar is not connected; could not start the next poll.');
        return false;
    }
    socket.emit('startPoll', nextPollPayload(prompt));
    return true;
}

function publicState(listener) {
    const data = listener.lastClassData;
    const poll = data && data.poll;
    const matching = isMatchingPoll(poll, listener.mode);
    const liveResponses = matching ? collectStudentTextResponses(data.students) : [];
    if (matching && liveResponses.length > 0) {
        listener.cachedResponses = liveResponses;
        listener.cachedResponsesPrompt = poll.prompt || '';
    }

    const responses = matching
        ? liveResponses
        : (listener.cachedResponses || []);

    const livePick = responses.length > 0 ? pickMostCommonFirstWord(responses) : null;
    // While a matching poll is open, tallies follow live answers; otherwise keep the last round.
    const wordTallies = matching
        ? (livePick ? livePick.tallies : [])
        : (listener.wordTallies || []);

    const hasActivePoll = isPollActive(poll);
    const percent = matching ? responsePercent(poll) : 0;
    const autoEndArmed = Boolean(
        listener.autoEndEnabled
        && matching
        && listener.autoEndDeadline
        && listener.autoEndForKey === pollKey(data)
    );

    return {
        user: listener.displayName,
        mode: listener.mode,
        className: displayClassName(listener),
        classId: data && data.id != null ? data.id : listener.classId,
        formbarConnected: Boolean(listener.formbarSocket && listener.formbarSocket.connected),
        autoEndEnabled: listener.autoEndEnabled,
        autoEndSeconds: listener.autoEndSeconds,
        autoEndPercent: listener.autoEndPercent,
        autoEndArmed,
        autoEndRemainingMs: autoEndArmed
            ? Math.max(0, listener.autoEndDeadline - Date.now())
            : null,
        sentence: listener.sentence || '',
        lastPick: listener.lastPick,
        wordTallies,
        talliesLive: Boolean(matching),
        round: listener.round || 0,
        advancing: listener.advancing,
        poll: matching || (hasActivePoll && listener.mode !== 'never')
            ? {
                prompt: matching
                    ? (poll.prompt || '')
                    : (listener.cachedResponsesPrompt || (poll && poll.prompt) || ''),
                totalResponses: matching
                    ? (Number(poll.totalResponses) || 0)
                    : (listener.cachedResponses ? listener.cachedResponses.length : 0),
                totalResponders: matching
                    ? (Number(poll.totalResponders) || 0)
                    : (listener.cachedResponses ? listener.cachedResponses.length : 0),
                percent: Math.round(percent),
                matching,
                isContinuation: matching ? isOurContinuationPoll(poll) : false
            }
            : null,
        responses,
        startEnabled: Boolean(
            listener.formbarSocket
            && listener.formbarSocket.connected
            && listener.classId != null
            && !listener.advancing
        ),
        nextWordEnabled: listener.mode !== 'never'
            && matching
            && liveResponses.length > 0
            && !listener.advancing
            && listener.processedKey !== pollKey(data),
        endPollEnabled: hasActivePoll
            && Boolean(listener.formbarSocket && listener.formbarSocket.connected)
            && !listener.advancing,
        statusMessage: listener.statusMessage
    };
}

function emitState(listener) {
    const state = publicState(listener);
    for (const browser of listener.browserSockets) {
        browser.emit('state', state);
    }
}

function emitError(listener, message) {
    for (const browser of listener.browserSockets) {
        browser.emit('appError', { message });
    }
}

function advanceSentence(listener, data, { forced }) {
    const key = pollKey(data);
    if (!key || listener.advancing) return;
    if (listener.processedKey === key) return;

    const textResponses = collectStudentTextResponses(data.students);
    const stopLoop = shouldEndLoopFromVotes(data.students);

    if (textResponses.length === 0) {
        if (stopLoop) {
            clearAutoEndTimer(listener);
            listener.advancing = true;
            listener.processedKey = key;
            listener.statusMessage = 'Over 80% chose End Response — sentence loop stopped.';
            emitState(listener);
            endFormbarPoll(listener);
            listener.advancing = false;
            emitState(listener);
            return;
        }
        emitError(listener, 'No text responses to use yet.');
        return;
    }

    clearAutoEndTimer(listener);
    listener.advancing = true;
    listener.processedKey = key;
    listener.cachedResponses = textResponses;
    listener.cachedResponsesPrompt = data.poll && data.poll.prompt ? data.poll.prompt : '';
    listener.statusMessage = forced
        ? 'Ending poll and picking the next word…'
        : 'Poll complete. Picking the next word…';
    emitState(listener);

    const pick = pickMostCommonFirstWord(textResponses);
    if (!pick) {
        listener.advancing = false;
        listener.statusMessage = 'Could not find a usable first word in the responses.';
        emitError(listener, listener.statusMessage);
        emitState(listener);
        return;
    }

    const currentPrompt = data.poll.prompt || '';
    const nextPrompt = buildNextPrompt(currentPrompt, pick.word, listener.mode);
    listener.sentence = stripScScTag(nextPrompt);
    listener.lastPick = {
        word: pick.word,
        count: pick.count,
        fromPrompt: stripScScTag(currentPrompt)
    };
    listener.wordTallies = pick.tallies;
    listener.round = (listener.round || 0) + 1;

    // Always count words from every text response. End Response only decides whether to continue.
    if (stopLoop) {
        listener.statusMessage = `Chose “${pick.word}” (${pick.count}). Over 80% chose End Response — sentence loop stopped.`;
        emitState(listener);
        endFormbarPoll(listener);
        listener.advancing = false;
        emitState(listener);
        return;
    }

    listener.statusMessage = `Chose “${pick.word}” (${pick.count}). Starting next poll…`;
    emitState(listener);

    // End current poll, then start the next word poll.
    endFormbarPoll(listener);

    setTimeout(() => {
        const started = startNextWordPoll(listener, nextPrompt);
        listener.advancing = false;
        if (started) {
            listener.statusMessage = `Next word poll started. Sentence: ${listener.sentence}`;
        } else {
            listener.processedKey = null;
        }
        emitState(listener);
    }, 400);
}

function maybeArmAutoEnd(listener, data) {
    const poll = data && data.poll;
    if (!listener.autoEndEnabled || !isMatchingPoll(poll, listener.mode)) {
        clearAutoEndTimer(listener);
        return;
    }

    const key = pollKey(data);
    if (!key || listener.processedKey === key || listener.advancing) {
        clearAutoEndTimer(listener);
        return;
    }

    const percent = responsePercent(poll);
    if (percent < listener.autoEndPercent) {
        clearAutoEndTimer(listener);
        return;
    }

    if (listener.autoEndForKey === key && listener.autoEndTimer) {
        return;
    }

    clearAutoEndTimer(listener);
    const seconds = Math.max(0, Number(listener.autoEndSeconds) || 0);
    listener.autoEndForKey = key;
    listener.autoEndDeadline = Date.now() + (seconds * 1000);
    listener.statusMessage = `${Math.round(percent)}% responded. Auto-ending in ${seconds}s…`;
    emitState(listener);

    listener.autoEndTimer = setTimeout(() => {
        listener.autoEndTimer = null;
        listener.autoEndDeadline = null;
        const latest = listener.lastClassData;
        if (!latest || pollKey(latest) !== key) return;
        if (listener.processedKey === key || listener.advancing) return;
        if (!isMatchingPoll(latest.poll, listener.mode)) return;
        advanceSentence(listener, latest, { forced: true });
    }, seconds * 1000);
}

function handleClassUpdate(listener, data) {
    if (!data) {
        listener.lastClassData = null;
        clearAutoEndTimer(listener);
        listener.statusMessage = 'Join a class in Formbar.';
        emitState(listener);
        return;
    }

    const key = pollKey(data);
    if (!key) {
        listener.pollEnded = true;
        clearAutoEndTimer(listener);
    } else {
        const pollChanged = listener.pollEnded || (listener.lastPollKey && key !== listener.lastPollKey);
        if (pollChanged) {
            listener.processedKey = null;
            clearAutoEndTimer(listener);
            // Keep sentence / last pick across continuation polls; reset cached live rows for a new prompt.
            if (!isOurContinuationPoll(data.poll)) {
                // Teacher started a fresh seed poll — reset the built sentence tracking for display of this round's base.
                if (!listener.advancing) {
                    listener.cachedResponses = null;
                    listener.cachedResponsesPrompt = null;
                }
            }
        }
        listener.pollEnded = false;
        listener.lastPollKey = key;
    }

    listener.lastClassData = data;
    listener.classId = data.id != null ? data.id : listener.classId;

    const poll = data.poll;
    const matching = isMatchingPoll(poll, listener.mode);
    const classLabel = displayClassName(listener);

    if (listener.mode === 'never') {
        clearAutoEndTimer(listener);
        listener.statusMessage = classLabel
            ? `Listening paused. Current class: ${classLabel}.`
            : 'Listening paused.';
        emitState(listener);
        return;
    }

    if (!isPollActive(poll)) {
        clearAutoEndTimer(listener);
        listener.statusMessage = classLabel
            ? `${classLabel}: no active poll.`
            : 'No active poll.';
        emitState(listener);
        return;
    }

    if (!matching) {
        clearAutoEndTimer(listener);
        listener.statusMessage = listener.mode === 'scsc'
            ? `Current poll does not start with ${SCSC_TAG}.`
            : 'Current poll is not a text poll.';
        emitState(listener);
        return;
    }

    const responses = collectStudentTextResponses(data.students);
    const percent = Math.round(responsePercent(poll));
    listener.statusMessage = `${responses.length} response${responses.length === 1 ? '' : 's'} · ${percent}% of class.`;
    emitState(listener);

    if (listener.advancing || listener.processedKey === key) return;

    if (isPollComplete(poll)) {
        advanceSentence(listener, data, { forced: false });
        return;
    }

    maybeArmAutoEnd(listener, data);
}

function connectFormbar(listener, formbarUrl) {
    if (listener.formbarSocket) {
        listener.formbarSocket.removeAllListeners();
        listener.formbarSocket.disconnect();
    }
    if (listener.classRefreshTimer) {
        clearInterval(listener.classRefreshTimer);
        listener.classRefreshTimer = null;
    }
    clearAutoEndTimer(listener);

    if (!listener.apiKey) {
        listener.statusMessage = 'Formbar API key is missing. Add API_KEY to .env.';
        emitState(listener);
        emitError(listener, listener.statusMessage);
        return;
    }

    const socket = io(formbarUrl, {
        extraHeaders: {
            api: listener.apiKey
        },
        autoConnect: false
    });

    listener.formbarSocket = socket;

    socket.on('connect', () => {
        listener.statusMessage = 'Connected to Formbar.';
        requestActiveClass(listener);
        emitState(listener);
        if (!listener.classRefreshTimer) {
            listener.classRefreshTimer = setInterval(() => {
                requestActiveClass(listener);
            }, CLASS_REFRESH_MS);
        }
    });

    socket.on('setClass', (newClassId) => {
        const classId = normalizeClassId(newClassId);
        listener.classId = classId;
        if (classId == null) {
            if (listener.jwtActiveClass != null && !listener.triedJoinClass) {
                listener.triedJoinClass = true;
                socket.emit('joinClass', listener.jwtActiveClass);
            }
            listener.lastClassData = listener.lastClassData && {
                ...listener.lastClassData,
                id: null,
                className: null,
                name: null,
                poll: null,
                students: {}
            };
            clearAutoEndTimer(listener);
            listener.statusMessage = 'No current classroom. Join a class in Formbar.';
            emitState(listener);
            return;
        }
        listener.triedJoinClass = false;
        socket.emit('classUpdate');
        emitState(listener);
    });

    socket.on('startPoll', () => {
        listener.statusMessage = 'Poll started in Formbar.';
        emitState(listener);
    });

    socket.on('error', (error) => {
        const message = error && error.message ? error.message : String(error);
        emitError(listener, `Formbar: ${message}`);
    });

    socket.on('connect_error', (error) => {
        listener.statusMessage = `Formbar connection error: ${error.message}`;
        emitState(listener);
        setTimeout(() => {
            if (listener.formbarSocket === socket && listener.browserSockets.size > 0) {
                socket.connect();
            }
        }, 5000);
    });

    socket.on('classUpdate', (data) => {
        handleClassUpdate(listener, data);
    });

    socket.connect();
}

function createListener(user, formbarUrl, apiKey) {
    const activeClass = normalizeClassId(user.activeClass);
    const listener = {
        formbarId: user.formbarId,
        displayName: user.displayName,
        rawJwt: user.rawJwt,
        apiKey: apiKey || '',
        jwtActiveClass: activeClass,
        triedJoinClass: false,
        mode: 'always',
        autoEndEnabled: true,
        autoEndSeconds: DEFAULT_AUTO_END_SECONDS,
        autoEndPercent: DEFAULT_AUTO_END_PERCENT,
        autoEndTimer: null,
        autoEndDeadline: null,
        autoEndForKey: null,
        formbarSocket: null,
        browserSockets: new Set(),
        lastClassData: null,
        cachedResponses: null,
        cachedResponsesPrompt: null,
        sentence: '',
        lastPick: null,
        wordTallies: [],
        round: 0,
        advancing: false,
        processedKey: null,
        lastPollKey: null,
        pollEnded: false,
        classId: activeClass,
        classRefreshTimer: null,
        statusMessage: 'Connecting to Formbar…',
        disconnectTimer: null
    };

    connectFormbar(listener, formbarUrl);
    return listener;
}

function attachBrowser(user, browserSocket, formbarUrl, apiKey) {
    const id = String(user.formbarId);
    let listener = listeners.get(id);

    if (!listener) {
        listener = createListener(user, formbarUrl, apiKey);
        listeners.set(id, listener);
    } else {
        listener.rawJwt = user.rawJwt;
        listener.displayName = user.displayName;
        listener.apiKey = apiKey || listener.apiKey;
        listener.jwtActiveClass = normalizeClassId(user.activeClass) != null
            ? normalizeClassId(user.activeClass)
            : listener.jwtActiveClass;
        if (listener.classId == null && listener.jwtActiveClass != null) {
            listener.classId = listener.jwtActiveClass;
        }
        if (listener.disconnectTimer) {
            clearTimeout(listener.disconnectTimer);
            listener.disconnectTimer = null;
        }
        if (!listener.formbarSocket || !listener.formbarSocket.connected) {
            connectFormbar(listener, formbarUrl);
        }
    }

    listener.browserSockets.add(browserSocket);
    emitState(listener);

    browserSocket.on('setMode', (mode) => {
        if (!MODES.has(mode)) return;
        listener.mode = mode;
        if (mode === 'never') clearAutoEndTimer(listener);
        handleClassUpdate(listener, listener.lastClassData);
    });

    browserSocket.on('setAutoEnd', (settings) => {
        if (!settings || typeof settings !== 'object') return;
        if (typeof settings.enabled === 'boolean') {
            listener.autoEndEnabled = settings.enabled;
        }
        if (settings.seconds != null) {
            const seconds = Number(settings.seconds);
            if (Number.isFinite(seconds) && seconds >= 0) {
                listener.autoEndSeconds = Math.min(600, Math.floor(seconds));
            }
        }
        if (settings.percent != null) {
            const percent = Number(settings.percent);
            if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
                listener.autoEndPercent = Math.floor(percent);
            }
        }
        if (!listener.autoEndEnabled) {
            clearAutoEndTimer(listener);
        }
        handleClassUpdate(listener, listener.lastClassData);
    });

    browserSocket.on('startSentence', (payload) => {
        const rawPrompt = payload && typeof payload.prompt === 'string'
            ? payload.prompt
            : (typeof payload === 'string' ? payload : '');
        if (!String(rawPrompt || '').trim()) {
            emitError(listener, 'Enter a prompt to start.');
            return;
        }
        if (!listener.formbarSocket || !listener.formbarSocket.connected) {
            emitError(listener, 'Formbar is not connected.');
            return;
        }
        if (listener.classId == null) {
            emitError(listener, 'Join a class in Formbar first.');
            return;
        }
        if (listener.advancing) {
            emitError(listener, 'Already advancing to the next poll.');
            return;
        }

        // Starting a sentence turns listening on if it was off.
        if (listener.mode === 'never') {
            listener.mode = 'always';
        }

        const prompt = buildSeedPrompt(rawPrompt, listener.mode);

        clearAutoEndTimer(listener);
        listener.sentence = stripScScTag(prompt);
        listener.lastPick = null;
        listener.wordTallies = [];
        listener.round = 0;
        listener.processedKey = null;
        listener.cachedResponses = null;
        listener.cachedResponsesPrompt = null;
        listener.statusMessage = 'Starting sentence poll…';
        emitState(listener);

        if (listener.lastClassData && isPollActive(listener.lastClassData.poll)) {
            endFormbarPoll(listener);
            setTimeout(() => {
                const started = startNextWordPoll(listener, prompt);
                listener.statusMessage = started
                    ? `Sentence poll started: ${stripScScTag(prompt)}`
                    : listener.statusMessage;
                emitState(listener);
            }, 400);
            return;
        }

        const started = startNextWordPoll(listener, prompt);
        if (started) {
            listener.statusMessage = `Sentence poll started: ${stripScScTag(prompt)}`;
        }
        emitState(listener);
    });

    browserSocket.on('endPollNow', () => {
        const data = listener.lastClassData;
        if (!data || !isMatchingPoll(data.poll, listener.mode)) {
            emitError(listener, 'No matching text poll to end.');
            return;
        }
        const responses = collectStudentTextResponses(data.students);
        if (responses.length === 0 && !shouldEndLoopFromVotes(data.students)) {
            emitError(listener, 'No text responses to use yet.');
            return;
        }
        advanceSentence(listener, data, { forced: true });
    });

    browserSocket.on('endPoll', () => {
        const data = listener.lastClassData;
        if (!data || !isPollActive(data.poll)) {
            emitError(listener, 'No active poll to end.');
            return;
        }
        if (!listener.formbarSocket || !listener.formbarSocket.connected) {
            emitError(listener, 'Formbar is not connected.');
            return;
        }
        if (listener.advancing) {
            emitError(listener, 'Already advancing to the next poll.');
            return;
        }

        clearAutoEndTimer(listener);
        const key = pollKey(data);
        if (key) listener.processedKey = key;
        endFormbarPoll(listener);
        listener.statusMessage = 'Poll ended. Sentence loop stopped.';
        emitState(listener);
    });

    browserSocket.on('resetSentence', () => {
        listener.sentence = '';
        listener.lastPick = null;
        listener.wordTallies = [];
        listener.round = 0;
        listener.statusMessage = 'Sentence cleared. Enter a new prompt above to start again.';
        emitState(listener);
    });

    browserSocket.on('disconnect', () => {
        listener.browserSockets.delete(browserSocket);
        if (listener.browserSockets.size === 0) {
            listener.disconnectTimer = setTimeout(() => {
                if (listener.browserSockets.size === 0) {
                    stopListener(id);
                }
            }, DISCONNECT_GRACE_MS);
        }
    });
}

function stopListener(formbarId) {
    const id = String(formbarId);
    const listener = listeners.get(id);
    if (!listener) return;

    if (listener.disconnectTimer) {
        clearTimeout(listener.disconnectTimer);
    }
    clearAutoEndTimer(listener);
    if (listener.classRefreshTimer) {
        clearInterval(listener.classRefreshTimer);
        listener.classRefreshTimer = null;
    }
    if (listener.formbarSocket) {
        listener.formbarSocket.removeAllListeners();
        listener.formbarSocket.disconnect();
    }
    listeners.delete(id);
}

module.exports = {
    attachBrowser,
    stopListener
};
