const HELP = {
    start: {
        title: 'Start',
        body: 'Enter a seed prompt and start a Formbar text poll from this page. Students submit the next word; this app tallies first words and continues the sentence. In [ScSc] listen mode, the tag is added automatically if you leave it off.'
    },
    mode: {
        title: 'Listen mode',
        body: 'Always Off ignores class polls. Always On watches every free-text poll and, when a round finishes, appends the most common first word and starts the next poll. With [ScSc] tag only watches text polls whose question starts with [ScSc], so ordinary polls do not trigger the sentence loop.'
    },
    end: {
        title: 'Poll control',
        body: 'Next Word Now ends the current matching text poll using responses so far, picks the most common first word, appends it, and starts the next “Submit Next Word” / “End Response” poll. End Poll closes the Formbar poll and stops the sentence loop without advancing. If more than 80% of responders pick End Response, the winning word is still counted and appended, then the loop stops.'
    },
    autoend: {
        title: 'Auto-end',
        body: 'When at least X% of the class has responded, wait Y seconds, then end the poll and continue the sentence automatically. Defaults are 80% and 5 seconds. Turn this off if you only want full completion or Next Word Now.'
    },
    sentence: {
        title: 'Built sentence',
        body: 'The growing prompt after each round, without the [ScSc] tag. Clear sentence resets the display only; start a new seed prompt above to begin another chain.'
    },
    tallies: {
        title: 'Word tallies',
        body: 'Live normalized first-word counts from the current matching poll. Letters match case-insensitively; digits and numbers (including decimals) are kept; punctuation-only answers like “!” count as words.'
    },
    responses: {
        title: 'Student responses',
        body: 'Live text answers from the current matching poll, plus the first word that will be counted. This table stays empty in Always Off mode, or when the current poll does not match Always On / [ScSc].'
    }
};

const socket = io();
const classLabel = document.getElementById('class-label');
const userName = document.getElementById('user-name');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const startForm = document.getElementById('start-form');
const seedPrompt = document.getElementById('seed-prompt');
const startBtn = document.getElementById('start-btn');
const sentenceEl = document.getElementById('sentence');
const lastPickEl = document.getElementById('last-pick');
const talliesEl = document.getElementById('tallies');
const responsesEl = document.getElementById('responses');
const pollMeta = document.getElementById('poll-meta');
const nextWordBtn = document.getElementById('next-word');
const endBtn = document.getElementById('end-poll');
const resetBtn = document.getElementById('reset-sentence');
const autoEnabled = document.getElementById('auto-end-enabled');
const autoSeconds = document.getElementById('auto-end-seconds');
const autoPercent = document.getElementById('auto-end-percent');
const autoStatus = document.getElementById('auto-end-status');
const helpDialog = document.getElementById('help-dialog');
const helpTitle = document.getElementById('help-title');
const helpBody = document.getElementById('help-body');

let applyingAutoSettings = false;
let countdownTimer = null;

function setText(el, text, hiddenIfEmpty) {
    el.textContent = text || '';
    if (hiddenIfEmpty) el.hidden = !text;
}

function firstWord(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    const match = trimmed.match(/^\S+/);
    return match ? match[0] : '';
}

function emitAutoEnd() {
    if (applyingAutoSettings) return;
    socket.emit('setAutoEnd', {
        enabled: autoEnabled.checked,
        seconds: Number(autoSeconds.value),
        percent: Number(autoPercent.value)
    });
}

function renderTallies(rows, live) {
    if (!rows || rows.length === 0) {
        talliesEl.className = 'tallies empty';
        talliesEl.textContent = live
            ? 'Waiting for first-word votes…'
            : 'Tallies appear as students respond.';
        return;
    }

    talliesEl.className = 'tallies';
    talliesEl.replaceChildren();
    rows.forEach((row, index) => {
        const item = document.createElement('div');
        item.className = index === 0 ? 'tally winner' : 'tally';
        const word = document.createElement('div');
        word.textContent = row.word;
        const count = document.createElement('div');
        count.className = 'tally-count';
        count.textContent = `${row.count} vote${row.count === 1 ? '' : 's'}`;
        item.appendChild(word);
        item.appendChild(count);
        talliesEl.appendChild(item);
    });
}

function renderResponses(rows) {
    responsesEl.replaceChildren();
    if (!rows || rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.className = 'muted';
        td.textContent = 'No matching text poll yet.';
        tr.appendChild(td);
        responsesEl.appendChild(tr);
        return;
    }

    for (const row of rows) {
        const tr = document.createElement('tr');
        const name = document.createElement('td');
        const response = document.createElement('td');
        const word = document.createElement('td');
        name.textContent = row.studentName || '';
        response.textContent = row.response || '';
        word.textContent = row.firstWord || firstWord(row.response);
        tr.appendChild(name);
        tr.appendChild(response);
        tr.appendChild(word);
        responsesEl.appendChild(tr);
    }
}

function clearCountdown() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
}

function startCountdown(remainingMs) {
    clearCountdown();
    if (remainingMs == null) {
        autoStatus.textContent = '';
        return;
    }

    let left = Math.max(0, remainingMs);
    const tick = () => {
        const seconds = Math.ceil(left / 1000);
        autoStatus.textContent = `Auto-ending in ${seconds}s…`;
        if (left <= 0) {
            clearCountdown();
            return;
        }
        left -= 250;
    };
    tick();
    countdownTimer = setInterval(tick, 250);
}

function render(state) {
    userName.textContent = state.user || '';
    classLabel.textContent = state.className
        ? state.className
        : (state.classId != null && state.classId !== ''
            ? `Class ${state.classId}`
            : (state.formbarConnected ? 'No class' : 'Connecting to Formbar…'));

    setText(statusEl, state.statusMessage, true);

    document.querySelectorAll('.seg').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });

    applyingAutoSettings = true;
    autoEnabled.checked = Boolean(state.autoEndEnabled);
    autoSeconds.value = state.autoEndSeconds != null ? state.autoEndSeconds : 5;
    autoPercent.value = state.autoEndPercent != null ? state.autoEndPercent : 80;
    applyingAutoSettings = false;

    if (state.autoEndArmed && state.autoEndRemainingMs != null) {
        startCountdown(state.autoEndRemainingMs);
    } else {
        clearCountdown();
        autoStatus.textContent = state.autoEndEnabled
            ? `Waits ${state.autoEndSeconds}s after ${state.autoEndPercent}% respond.`
            : 'Auto-end is off.';
    }

    nextWordBtn.disabled = !state.nextWordEnabled;
    nextWordBtn.textContent = state.advancing
        ? 'Advancing…'
        : 'Next Word Now';

    endBtn.disabled = !state.endPollEnabled;
    endBtn.textContent = 'End Poll';

    startBtn.disabled = !state.startEnabled;
    startBtn.textContent = state.advancing
        ? 'Starting…'
        : 'Start sentence poll';

    if (state.sentence) {
        sentenceEl.className = 'sentence';
        sentenceEl.textContent = state.sentence;
    } else {
        sentenceEl.className = 'sentence empty';
        sentenceEl.textContent = 'Enter a prompt above to start. Winning first words will grow the sentence here.';
    }

    if (state.lastPick && state.lastPick.word) {
        lastPickEl.textContent = `Round ${state.round || 0}: chose “${state.lastPick.word}” (${state.lastPick.count} vote${state.lastPick.count === 1 ? '' : 's'}).`;
    } else {
        lastPickEl.textContent = '';
    }

    if (state.poll && state.poll.matching) {
        pollMeta.textContent = `${state.poll.prompt} · ${state.poll.totalResponses}/${state.poll.totalResponders} responses (${state.poll.percent || 0}%)`;
    } else if (state.poll) {
        pollMeta.textContent = state.poll.prompt || '';
    } else {
        pollMeta.textContent = '';
    }

    renderTallies(state.wordTallies, state.talliesLive);
    renderResponses(state.responses);
}

document.querySelectorAll('.seg').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.seg').forEach((other) => {
            other.classList.toggle('active', other === btn);
        });
        socket.emit('setMode', btn.dataset.mode);
    });
});

startForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = seedPrompt.value.trim();
    if (!prompt) return;
    socket.emit('startSentence', { prompt });
});

nextWordBtn.addEventListener('click', () => {
    socket.emit('endPollNow');
});

endBtn.addEventListener('click', () => {
    socket.emit('endPoll');
});

resetBtn.addEventListener('click', () => {
    socket.emit('resetSentence');
});

autoEnabled.addEventListener('change', emitAutoEnd);
autoSeconds.addEventListener('change', emitAutoEnd);
autoPercent.addEventListener('change', emitAutoEnd);

document.querySelectorAll('.help').forEach((btn) => {
    btn.addEventListener('click', () => {
        const help = HELP[btn.dataset.help];
        if (!help) return;
        helpTitle.textContent = help.title;
        helpBody.textContent = help.body;
        helpDialog.showModal();
    });
});

socket.on('state', (state) => {
    errorEl.hidden = true;
    render(state);
});

socket.on('appError', ({ message }) => {
    setText(errorEl, message, true);
});
