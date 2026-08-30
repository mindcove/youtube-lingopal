# YouTube Lingopal

*[中文说明](README.zh-CN.md)*

> **Turn YouTube videos into language learning** — bilingual subtitles, instant word explanations, and one-key notes, without pausing the video.

Translates subtitles into **Chinese, English, or French**, side by side, on the spot.

![Side panel](docs/screenshot-panel.jpg)

---

## Main features

| | |
|---|---|
| **Subtitle overlay** | Subtitles on the video, shown as **both languages / original only / translation only** |
| **Full transcript** | The whole transcript with timestamps in the side panel; click one to jump |
| **One-key notes** | Press `Note` or the shortcut to keep the sentence that just finished; it goes straight into Notes |
| **Save words** | Words and phrases you look up or select go into your vocabulary list automatically |

All of the above work without an API key — click "Skip for now" on the first-run banner.

### Needs an API key

| | |
|---|---|
| **Hover translation** | A word's meaning as you hover over it |
| **Word explanation** | Click any word in the subtitles for a card explaining what it means in that sentence |
| **Phrase explanation** | Select a phrase in the current sentence and click the button |
| **Usage explanation** | A button in the vocabulary list: how the expression is actually **used** — the patterns it appears in, who says it and how formally, what people get wrong about it |
| **Overview** | What each part of the video covers, with clickable timestamps |
| **Re-translate transcript** | Retranslate the whole transcript with AI |

---

## Install

### With an AI coding assistant (Claude Code, Codex, …)

Paste this:

```
Install the Chrome extension at https://github.com/mindcove/youtube-lingopal:
Ask me where to put it first, then start once I have answered.
Clone it into that folder, tell me the full path when you are done,
then tell me how to load that same folder with "Load unpacked" on chrome://extensions.
```

### By hand

1. Click the green `Code` button → `Download ZIP`, and unzip it into a **permanent folder**
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the folder you just unzipped
5. Open a YouTube video with captions, then click YouTube Lingopal in the toolbar (it may be tucked inside the 🧩 menu — 📌 pins it out) or the yellow `YT Pal` button at the bottom right of the page

Requires Chrome 116 or later.

---

## API key and cost

**Anything labelled AI in the interface costs money**; everything else works without a key.

If you don't have an API key yet, create one at [platform.deepseek.com](https://platform.deepseek.com) (it starts with `sk-`).

The first time you open the panel it asks for the key; you can also change it later under the gear ⚙ at the top right of the side panel.

**The key is stored only in your own Chrome and is never uploaded anywhere.** It is sent to the API endpoint you configured, and nowhere else.

> ⚠️ **Never paste your API key into an AI chat, source code, a screenshot, or anywhere else that could become public** — type it straight into the settings field. If one does leak, delete it in the DeepSeek console and create a new one.

| Feature | Per use |
|---|---|
| Hover translation | $0.00003 – 0.00006 |
| Word / phrase explanation | $0.0003 – 0.0009 |
| Usage explanation | $0.0007 – 0.002 |
| Overview | $0.001 – 0.006 (once per video, then cached) |
| Re-translate transcript | $0.04 – 0.10 for a 20-minute video |
| Sentence splitting (automatic, see below) | $0.00004 – 0.00007 |

Measured, then rounded up: a 20-minute video — **3 word explanations**, **5 words hovered**, **one overview** — costs about **$0.0015 – 0.009**.

> **Sentence splitting**: on old auto-generated captions with no punctuation, the rules cannot tell where a sentence ends, so pressing `N` or clicking `Note` triggers one AI call to find the boundary. It only happens when both conditions hold — unpunctuated captions *and* saving a note — and most modern auto-captions are punctuated. It counts toward the total in the usage panel.

The usage panel in settings records the **real token counts** for every call, broken down per feature and resettable. The money figure there is still computed from list prices — **your DeepSeek bill is the authority**.

> The API is OpenAI-compatible. Only DeepSeek has been tested.

---

## How to use it

**Only works on YouTube videos with captions (CC)** — if the player has a CC button, it has them.

**Open the panel**: the extension icon in the toolbar, or the `YT Pal` button at the bottom right of the video page.

### Subtitle display

The **View** control in the subtitle toolbar switches between **both languages / original only / translation only**. The video overlay and the side panel change together.

### Keyboard shortcuts

| Key | What it does | Where |
|---|---|---|
| `N` | Save the sentence that just finished | On the video |
| `R` | Replay the current sentence | On the video |
| `V` | Save a word or phrase to your vocabulary | Select it in the transcript or current sentence, or hover a word on the video |
| `H` | Add or remove a highlight on the selected text | Notes and Vocabulary tabs |

None of these fire while you are typing in an edit box.

### Notes and vocabulary

Every card in both tabs can be:

- **Edited** — original and translation separately
- **Replayed** — jumps back to that moment in the video
- **Copied** — the original alone, or original plus translation plus your annotation
- **Deleted**

Notes also take a free-text **annotation**.

### Saved the wrong sentence

The confirmation toast gives you three ways out: **add previous line** (click repeatedly), **undo** (deletes what was just saved), and **✕**.

### Highlights

Words you looked up are highlighted in their example sentence automatically. You can also select anything in a note or vocabulary card and press `H`. Markdown export writes highlights as `==word==`; HTML export keeps the real highlight colour.

### Export and backup

Both the Notes and Vocabulary tabs have an export button. Pick any combination of **notes / vocabulary / full transcript**, as Markdown, HTML, or CSV — and for the transcript, original only, translation only, or both.

**Backup** at the bottom of settings writes a JSON file you can import after reinstalling. Take one right after you install — the data lives inside Chrome, and **moving or deleting the install folder, or uninstalling the extension, puts it out of reach**.

### Off by default

- **Hover translation** — every new word your cursor crosses costs an API call. Tick it in settings to enable it.
- **Quality first** — when off, sentence and full-transcript translation use YouTube's own caption translation; when on, they go through the API instead.

### Interface language

Switch between **English, 中文, or follow-browser** in settings, at any time. The interface language and the translation target language are separate settings.

---

## Troubleshooting

**"This video has no captions (CC)"**
The video has no caption track, so the extension cannot work on it.

**"Could not get caption authorisation"**
Turn captions (CC) on manually in the player, then reload the page.

**Clicked, nothing happened**
Reload the YouTube page first. If that doesn't help, hit the refresh icon for this extension on `chrome://extensions` and reload the page again.

**The original language is detected wrong**
A few videos ship a dozen human-uploaded caption tracks, and there is no way to tell which one matches the audio. Use the **Original** dropdown in the subtitle toolbar; the choice is remembered per video.

---

## Data and privacy

Notes, vocabulary, settings, and your API key live only in your own Chrome. The extension talks to exactly two places: YouTube (for captions) and the API endpoint you configured. No analytics, no telemetry.

---

## License

MIT — see [LICENSE](LICENSE).
