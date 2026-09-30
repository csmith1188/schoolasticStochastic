# Schoolastic Stochastic

Collaborative sentence builder for Formbar. Students submit text responses across multiple polls; after each round the app picks the most common first word, appends it to the prompt, and starts the next poll.

## Features

- One-page teacher control panel (Formbar OAuth, teachers only)
- **Always Off / Always On / With [ScSc] tag** listen modes
- **End poll now** — force the current round using responses so far, then continue
- Automatic loop: complete poll → count first words → append winner → start next text poll with a **Submit Next Word** button
- **Auto-end**: when X% of the class has responded, wait Y seconds, then continue (defaults: 80% and 5s)
- No AI — word choice is pure frequency counting after normalization

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set:
   - `API_KEY` — your Formbar API key
   - `AUTH_URL` — Formbar base URL (default `https://formbar.yorktechapps.com`)
   - `THIS_URL` — where this app is reachable (default `http://localhost:3000`)
   - `SESSION_SECRET` — session cookie secret

3. Run:
   ```bash
   npm start
   ```

4. Open the app, sign in with a Formbar **teacher** account, and join a class in Formbar.

## Classroom flow

1. Set listen mode to **Always On**, or **With [ScSc] tag** if you only want polls whose prompt starts with `[ScSc]`.
2. In Formbar, start a **text** poll with a seed prompt (for example `Once upon a time` or `[ScSc] Once upon a time`).
3. Students submit a word (or a phrase — only the first word counts).
4. When everyone has answered, you press **End poll now**, or auto-end fires, the app:
   - collects first words
   - normalizes them (lowercase, strip whitespace/punctuation) and counts matches
   - appends the most common word to the prompt
   - starts a new text poll with one button: **Submit Next Word**
5. Repeat. Switch to **Always Off** to stop the loop.

## Notes

- Auto-end settings live on the control panel and apply to the current teacher session listener.
- **Clear sentence** only resets the control-panel display; start a new seed poll in Formbar to begin another chain.
