# Worked Up

Make multi-card posts for Instagram and Facebook by talking. Worked Up keeps the Musings Studio card format and deck layout, and adds:

- **A voice bar.** Tap the microphone and say what to change, like "make the title bigger and gold," "black and white with dark edges," or "add three cards." Typing in the box works too, including the keyboard's microphone. Undo and Redo are always there.
- **Photo tools.** 15 looks (warm, cool, sepia, black & white, noir, vintage, faded, pop, dreamy, duotone, poster, comic dots, pixels, pencil sketch). Brightness, contrast, color, warmth, tint, fade, dark edges, grain, blur and sharpen. Zoom, drag to reframe, rotate and mirror.
- **AI restyle.** Turn a card's photo into a watercolor, oil painting, pencil drawing, or any style you describe. It always works from the original photo, and "Back to original photo" undoes it.
- **Share.** Share sends the finished cards to Instagram or Facebook through the phone's share button. Save as a .zip or to Drive also works.

It runs in the browser, installs on a phone like an app, works offline (except voice and AI), and syncs to Google Drive.

---

## Step 1. Turn on GitHub Pages

1. In this repo, go to **Settings → Pages**.
2. Set **Source** to **Deploy from a branch**, the branch to **main**, and the folder to **/ (root)**. Click **Save**.
3. After a minute or two, the app is live at `https://laustenfaund.github.io/WorkedUp/`

## Step 2. Google Drive sync

Nothing to do. `config.js` already has the same Google values as Musings Studio, and they cover every app at `laustenfaund.github.io`. Worked Up keeps its files in its own **Worked Up** folder in Drive.

## Step 3. The Gemini key (voice changes and AI styles)

1. Get a key at **aistudio.google.com → Get API key**. Use your existing one if you have it.
2. Recommended: in **console.cloud.google.com → APIs & Services → Credentials**, open that key and set **Application restrictions → Websites** to `https://laustenfaund.github.io/*`. Then the key only works from the app.
3. On each phone, open Worked Up → **Library → Voice and AI**, paste the key, and tap **Check key**. The app picks the newest Gemini models the key can use.

The key is saved only on that phone. It is never put in this repo, synced to Drive, or included in backups.

## Step 4. Put it on the home screen

- **Pixel (Chrome):** open the link, then **Library → Install app** (or the browser menu → Install app).
- **iPhone (Safari):** open the link, tap **Share → Add to Home Screen**.

## Voice notes

- Voice uses the phone's own speech recognition, which needs the internet.
- On iPhone, voice can refuse to start inside the home-screen app. If that happens, tap the text box and use the keyboard's microphone key instead. It works the same way.
- Tap a piece of text on the card to point at it, or name it: "the title," "the caption," "card 3."
- Tap **?** in the voice bar for example phrases.

## Files

- `index.html`: page and styles
- `manual.html`: the user manual, opened with the Manual button at the top of the app
- `app.js`: cards, photo tools, voice, AI and export
- `drive.js`: Google Drive sync
- `config.js`: Google values for Drive (not secret; they only work from this site)
- `sw.js`, `manifest.webmanifest`, `icons/`: offline and install support
- `vendor/`: JSZip (zip export and backups) and Sortable (drag to reorder)
