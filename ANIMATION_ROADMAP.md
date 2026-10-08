# Mike Animation Roadmap

Scope: the character's animation only (body, face, gaze, timing). Nothing here
touches the board, Gemini lesson content, or the studio UI beyond what the
animation needs.

## Workflow

One item at a time, in the order below.

1. **Fix** — I implement the item and list what changed and how to test it.
2. **Test** — you run `npm run dev`, try the steps under "How to test", and
   watch for the "Done when" behaviour.
3. **Confirm** — you reply with "confirmed" or with what still looks wrong.
   Anything wrong gets fixed before we move on.
4. **Next** — I start the following item.

Status legend: `[x]` implemented, awaiting your test · `[v]` confirmed by you ·
`[ ]` not started.

---

## Round 1 (implemented, please test)

### 1. Gesture economy `[x]`

**Problem:** Mike gestured non‑stop. The speech performer chained filler
gestures back-to-back until the whole line was covered, so every second of
speech had a hand moving. Real presenters gesture on a fraction of what they
say and rest between beats.

**Fix:**
- One *opener* gesture lands with the first words of a line, held up to 2.4 s.
- After that, at most one soft *beat* every 5.5–9 s, and only if ≥ 2.6 s of
  speech remain so the gesture can finish. Max 3 beats per line.
- Gestures now carry a weight: point/emphasize 1.5, reveal 1.3, welcome/wave
  1.3, explain 1.0, offer 0.9, think 0.75, listen 0.7. Beats play at 0.85.
- New gesture intent `none` (aliases `rest`, `continue`, `talk`): Mike speaks
  with his hands down, no opener. Gemini is told about one segment in three
  should be `none` (transitions, short conversational lines, follow-ups).

Files: `components/MikeModel.tsx`, `lib/presentationGestures.ts`,
`app/api/gemini/route.ts`, `components/LixiaStudio.tsx`.

**How to test:**
- Ask for a lesson with 5+ segments. Watch a long segment: one gesture at the
  start, hands settle, then a single smaller gesture a few seconds later.
- Some segments should have no opener at all (hands stay in the idle pose
  while he talks).
- "Point at the board" / "emphasize" lines should look visibly stronger than
  "explain" lines.

**Done when:** you can watch a full lesson and there are clear stretches of
talking with the hands at rest, and no gesture feels like it was cut off.

### 3. Gaze: eye contact and board glances `[x]`

**Problem:** The head/eyes were locked to the clip. He never looked at the
viewer or at what he was writing.

**Fix:** New procedural layer `lib/mikePresence.ts` (`MikePresenceRig`),
applied after the mixer each frame:
- Default gaze is the **camera** (eye contact). Head/neck take ~70 % of the
  turn (clamped to ±0.6 rad yaw, ±0.28 pitch), eyes take the rest and move
  ~4× faster than the head.
- Small eye **saccades** every 0.9–2.6 s so the eyes never sit dead still.
- `glanceAtBoard(seconds)`: brief look at the board, then back. Triggered
  automatically on board‑referencing intents (point, reveal, explain,
  contrast, next…), capped at half the line's length or 2.6 s.
- Gaze never runs while paused (the old head‑spin bug came from applying
  rotations on a frozen mixer). Eye bones reset to rest each frame because the
  body clips don't drive them.
- Old `lookStrength` prop/state removed; API is `setGaze("camera" | "board" |
  "none")`, `glanceAtBoard()`, and `setLookAtBoard()` kept as a shim.

**How to test:**
- Idle: orbit/switch camera shots — his head and eyes should follow the
  camera softly, eyes leading the head.
- During a lesson, on "point"/"reveal" lines he should look at the board for a
  moment and come back to you.
- Pause mid‑lesson: head must stay still (no drift/spin).

**Done when:** he feels like he is talking *to* you, and the board glances
look like a teacher checking their notes, not a robotic snap.

### 5. Micro‑motion (breathing, weight shift, speech nods) `[x]`

**Problem:** Between gestures he was a statue.

**Fix (same `MikePresenceRig`):**
- **Breathing:** 0.21 Hz pitch on Spine01/Spine02 (0.009 rad), with a
  half‑strength counter on the head so the chest rises without the face
  bobbing.
- **Weight shift:** every 9–15 s eases 2.8 cm left/right on the root with a
  hint of spine roll (30 % of the time he returns to centre).
- **Speech nods:** the lipsync mouth level feeds `noteSpeechLevel()`. A loud
  syllable (≥ 0.62) has a 55 % chance to trigger a 0.42 s nod of 0.04 rad,
  with a 1.4 s refractory so it never becomes a bobble‑head.

**How to test:**
- Idle for 20 s on the waist shot: subtle chest movement and an occasional
  slow lean.
- During speech: small nods on stressed words, not on every word.

**Done when:** nothing here is consciously noticeable, but freezing the
presence layer would make him look dead. If any motion *is* noticeable, it is
too strong and I'll dial it down.

---

## Round 2 (implemented, please test)

### 2. Emotion transitions with body follow‑through `[x]`

**Problem:** Faces changed instantly; the body didn't agree with them.

**Fix (`lib/mikePresence.ts`):** every emotion now has a small body posture
(chest open/settle, chin up/down, head tilt): happy/encouraging lift the
chest, thinking tilts the head (0.07 rad) and drops the chin a little,
concerned/serious settle forward, surprised pulls back, angry leans in.
Posture eases over ~0.6 s with a 0.7 s overshoot so the change reads as a
movement, not a re‑pose. `setEmotion` on the model API drives both the face
rig and the posture.

**How to test:** in the Emotions panel cycle neutral → happy → concerned →
serious → angry. Watch the shoulders/chest and head angle, not the face.

**Done when:** each switch has a visible but small body change that settles
within a second, and nothing looks like a snap.

### 4. Listening / attentive state `[x]`

**Problem:** While you typed or Lixia generated, he stood in plain idle.

**Fix:**
- Presence rig `setListening(true)`: head tilt 0.055 rad, slight chin drop,
  slow nod every 3–6.5 s (0.03 rad over 0.9 s). Gaze locked to camera.
- Studio: while the Ask box has text (and nothing is playing) → listening +
  `attentive` face + soft `listen` upper‑body loop (weight 0.5). While
  Gemini is generating → listening + `thinking` face (which also fires the
  "hm" reaction) + soft `think` loop (weight 0.55). Both release when speech
  starts or the box is cleared.
- The idle think/listen loops now blend under the idle arms instead of
  replacing them, and a loop that finishes loading after speech started is
  dropped.
- Lab: "Listening" toggle button.

**How to test:** type a long question slowly without sending — he should
tilt his head toward you and nod now and then. Send it — he should look like
he is thinking until the lesson starts.

**Done when:** he reacts to you before he answers, and the hands stay calm
throughout.

### 6. Reaction beats (laugh, hm, surprise, nod, shrug) `[x]`

**Problem:** No physical reactions between/around lines.

**Fix:**
- Presence rig `playReaction(kind)`:
  `laugh` two quick forward chest pulses with shoulder bounce (1.0 s);
  `hm` head tilt + slight lift (1.3 s); `surprise` fast pull‑back with
  shoulders (0.75 s); `nod` two deliberate nods (0.65 s); `shrug` shoulders
  up + head tilt (0.95 s). Shoulders use the clavicle bones.
- Auto‑triggered by emotion changes: amused → laugh, surprised → surprise,
  thinking → hm.
- Gemini: new optional `reaction` field per `teach_lesson` segment (enum
  none/laugh/hm/surprise/nod/shrug), prompted to use one or two per lesson.
  Played at the start of that segment's speech.
- Lab: a row of reaction buttons.

Files: `lib/mikePresence.ts`, `components/MikeModel.tsx`,
`components/LixiaStudio.tsx`, `app/api/gemini/route.ts`, `types/board.ts`,
`app/globals.css`.

**How to test:** Emotions panel → press each reaction on the face close‑up
and on the waist view. Then run a lesson that includes a fun fact or a joke.

**Done when:** the chuckle looks like a chuckle (shoulders, not just a face),
the shrug is readable from the waist shot, and a lesson gets at most a
couple of reactions.

---

## Round 3 (implemented, please test)

### 7. Gesture ↔ speech timing `[x]`

**Problem:** The opener fired at t = 0, often into silence, and later beats
were on a random clock.

**Fix:** The opener waits for the first loud syllable (mouth rising through
0.16 → 0.34) with a 0.05–0.38 s window. Later beats still have a 5.5–9 s
gap, but they fire on the next onset after that gap (0.55 s slack, 0.9 s if
he is in a pause) so the hand lands on a word.

**How to test:** start a lesson and watch the first gesture — it should
arrive with the first stressed word, not before he speaks.

**Done when:** gestures feel locked to speech, not to a metronome.

### 8. Hand rest poses and transitions `[x]`

**Problem:** When a gesture ended the arms popped back to the same idle.

**Fix:** After every opener/beat the queue cross‑fades into a looping rest
overlay: palms‑low (`seg_504`), clasped (`seg_427`), or a soft offer
(`seg_456`). The pose is chosen from the last intent and never repeats
itself. Rest weight stays low so it reads as a hold, not another gesture.

**How to test:** watch the end of each gesture — arms should settle into a
slightly different hold, not snap to the same idle every time.

**Done when:** there is no pop, and consecutive rests are not identical.

### 9. Camera‑aware performance `[x]`

**Problem:** Face/close shots made big arm sweeps read as noise.

**Fix:** Gesture weight is scaled by shot (face 0.36, close 0.5, waist 1.0,
full 1.12). Face skips the opener and all beats (hands rest, face works).
Close allows the opener plus at most one beat. Sway on the presence layer
is scaled the same way so the close‑up does not drift.

**How to test:** open Emotions → Face close‑up and run Talk, then switch to
waist during a lesson. Hands should stay small on the face shot.

**Done when:** close‑ups are face‑led; the waist/full shots still have
readable hands.

### 10. Idle variety `[x]`

**Problem:** The standing idle loop became recognisable over a long wait.

**Fix:** Every 26–42 s while he is at rest (not speaking, not listen/think)
a rest pose fades in for 5.5–8 s and out again. Never mid‑gesture.

**How to test:** leave him idle for two minutes on the waist shot.

**Done when:** the wait does not look like a looping GIF.

---

## Confirmed

_(moves here as you confirm each item)_
